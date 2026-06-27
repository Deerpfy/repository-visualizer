// CSharpCallGraph — a semantic, compiler-accurate call graph for a C# project, using
// Roslyn (Microsoft.CodeAnalysis). It resolves each invocation to the actual method
// symbol (not a name guess), follows VIRTUAL/INTERFACE dispatch to source implementations
// (class-hierarchy analysis), follows EVENT raises to their `+=` handlers, and flags
// parallel calls (Task.WhenAll / Parallel.*). Output is the same { functions, calls }
// shape the JS engine's finalizeCallGraph() consumes.
//
// Usage: CSharpCallGraph --root <dir> [--root-name <name>] [--out <file>]   (JSON → stdout)
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CSharpCallGraph
{
	static class Program
	{
		class FuncNode { public string id { get; set; } public string file { get; set; } public string name { get; set; } public string kind { get; set; } public int line { get; set; } }
		class Edge { public string from { get; set; } public string to { get; set; } public bool self { get; set; } public bool parallel { get; set; } public string via { get; set; } }
		class Result { public string provider { get; set; } public int files { get; set; } public List<FuncNode> functions { get; set; } public List<Edge> calls { get; set; } public List<string> warnings { get; set; } }

		static readonly HashSet<string> NoiseDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
		{ "bin", "obj", ".git", ".vs", ".vscode", ".idea", "node_modules", "packages", "TestResults", ".svn", ".hg" };

		static int Main(string[] args)
		{
			string root = null, rootName = null, outPath = null;
			for (int i = 0; i < args.Length; i++)
			{
				if (args[i] == "--root" && i + 1 < args.Length) root = args[++i];
				else if (args[i] == "--root-name" && i + 1 < args.Length) rootName = args[++i];
				else if (args[i] == "--out" && i + 1 < args.Length) outPath = args[++i];
			}
			if (string.IsNullOrEmpty(root)) { Console.Error.WriteLine("usage: --root <dir> [--root-name <name>] [--out <file>]"); return 2; }
			root = Path.GetFullPath(root);
			if (!Directory.Exists(root)) { Console.Error.WriteLine("root not found: " + root); return 2; }
			if (string.IsNullOrEmpty(rootName)) rootName = new DirectoryInfo(root.TrimEnd('/', '\\')).Name;

			var warnings = new List<string>();

			// --- collect + parse all .cs files into ONE compilation ----------------
			var files = new List<string>();
			CollectCs(root, files);
			var trees = new List<SyntaxTree>();
			foreach (var f in files)
			{
				try { trees.Add(CSharpSyntaxTree.ParseText(File.ReadAllText(f), path: f)); }
				catch (Exception e) { warnings.Add("parse failed: " + f + " — " + e.Message); }
			}

			// References = the analyzer's own runtime assemblies (TPA). Enough to resolve
			// System.* types for the analysed code; project-internal symbols always resolve
			// because all source trees are in the compilation.
			var refs = new List<MetadataReference>();
			if (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") is string tpa)
				foreach (var p in tpa.Split(Path.PathSeparator))
					if (p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && File.Exists(p))
						try { refs.Add(MetadataReference.CreateFromFile(p)); } catch { }

			var compilation = CSharpCompilation.Create("analysis", trees, refs,
				new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true));

			var functions = new Dictionary<string, FuncNode>();
			var edgeKeys = new HashSet<string>();
			var edges = new List<Edge>();
			var eventHandlers = new Dictionary<ISymbol, HashSet<IMethodSymbol>>(SymbolEqualityComparer.Default);
			var allTypes = AllTypes(compilation).ToList();

			// --- helpers (closures over the above) ---------------------------------
			string Prefixed(string abs)
			{
				string rel;
				try { rel = Path.GetRelativePath(root, abs); } catch { rel = Path.GetFileName(abs); }
				return rootName + "/" + rel.Replace('\\', '/');
			}
			string DisplayName(IMethodSymbol m)
			{
				// Qualify by containing type so same-named methods in different classes (and even
				// on the same source line) stay distinct: "OrderService.Process", "CardPayment.Pay".
				var t = m.ContainingType != null ? m.ContainingType.Name : "";
				var dot = t.Length > 0 ? t + "." : "";
				switch (m.MethodKind)
				{
					case MethodKind.Constructor: return t.Length > 0 ? t : "ctor";
					case MethodKind.StaticConstructor: return dot + "cctor";
					case MethodKind.PropertyGet: return dot + (m.AssociatedSymbol != null ? m.AssociatedSymbol.Name : m.Name) + ".get";
					case MethodKind.PropertySet: return dot + (m.AssociatedSymbol != null ? m.AssociatedSymbol.Name : m.Name) + ".set";
					case MethodKind.LocalFunction: return m.Name;
					default: return dot + m.Name;
				}
			}
			string KindOf(IMethodSymbol m)
			{
				switch (m.MethodKind)
				{
					case MethodKind.Constructor: case MethodKind.StaticConstructor: return "ctor";
					case MethodKind.LocalFunction: return "local";
					case MethodKind.PropertyGet: case MethodKind.PropertySet: return "accessor";
					default: return "method";
				}
			}
			SyntaxReference DeclOf(IMethodSymbol m) => m?.OriginalDefinition?.DeclaringSyntaxReferences.FirstOrDefault();
			string IdFor(IMethodSymbol m)
			{
				var decl = DeclOf(m); if (decl == null) return null; // not defined in our source
				var pos = decl.SyntaxTree.GetLineSpan(decl.Span).StartLinePosition;
				// id includes line:col so even overloads / same-line declarations are unique.
				return Prefixed(decl.SyntaxTree.FilePath) + "::" + DisplayName(m.OriginalDefinition) + "#" + (pos.Line + 1) + ":" + (pos.Character + 1);
			}
			void EnsureFunc(IMethodSymbol m)
			{
				var id = IdFor(m); if (id == null || functions.ContainsKey(id)) return;
				var decl = DeclOf(m);
				int line = decl.SyntaxTree.GetLineSpan(decl.Span).StartLinePosition.Line + 1;
				functions[id] = new FuncNode { id = id, file = Prefixed(decl.SyntaxTree.FilePath), name = DisplayName(m.OriginalDefinition), kind = KindOf(m), line = line };
			}
			FuncNode EnsureModule(string file)
			{
				var id = file + "::<module>";
				if (!functions.TryGetValue(id, out var n)) functions[id] = n = new FuncNode { id = id, file = file, name = "(module top-level)", kind = "module", line = 1 };
				return n;
			}
			void AddEdge(string from, string to, bool parallel, string via)
			{
				if (from == null || to == null) return;
				if (!edgeKeys.Add(from + "" + to)) return;
				edges.Add(new Edge { from = from, to = to, self = from == to, parallel = parallel, via = via });
			}
			string EnclosingId(SyntaxNode n, SemanticModel model)
			{
				for (var a = n.Parent; a != null; a = a.Parent)
				{
					if (a is MethodDeclarationSyntax || a is ConstructorDeclarationSyntax || a is LocalFunctionStatementSyntax
						|| a is AccessorDeclarationSyntax || a is OperatorDeclarationSyntax || a is DestructorDeclarationSyntax
						|| a is ConversionOperatorDeclarationSyntax)
					{
						var s = model.GetDeclaredSymbol(a) as IMethodSymbol;
						var id = IdFor(s);
						if (id != null) return id;
					}
				}
				return EnsureModule(Prefixed(n.SyntaxTree.FilePath)).id; // field init / top-level statement
			}

			// --- pass 1: every function definition --------------------------------
			foreach (var tree in trees)
			{
				var model = compilation.GetSemanticModel(tree);
				foreach (var node in tree.GetRoot().DescendantNodes())
				{
					if (node is MethodDeclarationSyntax || node is ConstructorDeclarationSyntax || node is LocalFunctionStatementSyntax
						|| node is AccessorDeclarationSyntax || node is OperatorDeclarationSyntax || node is DestructorDeclarationSyntax
						|| node is ConversionOperatorDeclarationSyntax)
					{
						if (model.GetDeclaredSymbol(node) is IMethodSymbol s) EnsureFunc(s);
					}
				}
			}

			// --- pass 2: event subscriptions (event += handler) -------------------
			foreach (var tree in trees)
			{
				var model = compilation.GetSemanticModel(tree);
				foreach (var assign in tree.GetRoot().DescendantNodes().OfType<AssignmentExpressionSyntax>())
				{
					if (!assign.IsKind(SyntaxKind.AddAssignmentExpression)) continue;
					if (model.GetSymbolInfo(assign.Left).Symbol is IEventSymbol ev)
					{
						var handler = model.GetSymbolInfo(assign.Right).Symbol as IMethodSymbol;
						if (handler != null && IdFor(handler) != null)
						{
							if (!eventHandlers.TryGetValue(ev.OriginalDefinition, out var set))
								eventHandlers[ev.OriginalDefinition] = set = new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default);
							set.Add(handler);
						}
					}
				}
			}

			// --- pass 3: calls, dispatch, events, constructors --------------------
			foreach (var tree in trees)
			{
				var model = compilation.GetSemanticModel(tree);
				foreach (var node in tree.GetRoot().DescendantNodes())
				{
					if (node is InvocationExpressionSyntax inv)
					{
						string callerId = EnclosingId(inv, model);
						bool parallel = InParallel(inv);
						var sym = model.GetSymbolInfo(inv);
						var target = (sym.Symbol ?? sym.CandidateSymbols.FirstOrDefault()) as IMethodSymbol;
						if (target == null) continue;

						var tid = IdFor(target);
						if (tid != null) AddEdge(callerId, tid, parallel, "call");

						// virtual / interface dispatch → source implementations & overrides
						if (IsDispatch(target))
							foreach (var impl in DispatchTargets(target, allTypes))
								AddEdge(callerId, IdFor(impl), parallel, "dispatch");

						// event raise: Event(...) / Event.Invoke(...) / Event?.Invoke(...)
						if (target.MethodKind == MethodKind.DelegateInvoke)
						{
							var ev = EventOf(inv, model);
							if (ev != null && eventHandlers.TryGetValue(ev.OriginalDefinition, out var hs))
								foreach (var h in hs) AddEdge(callerId, IdFor(h), parallel, "event");
						}
					}
					else if (node is ObjectCreationExpressionSyntax oc)
					{
						if (model.GetSymbolInfo(oc).Symbol is IMethodSymbol ctor)
						{
							var tid = IdFor(ctor);
							if (tid != null) AddEdge(EnclosingId(oc, model), tid, InParallel(oc), "new");
						}
					}
				}
			}

			var result = new Result { provider = "roslyn", files = trees.Count, functions = functions.Values.ToList(), calls = edges, warnings = warnings };
			var json = JsonSerializer.Serialize(result);
			if (!string.IsNullOrEmpty(outPath)) File.WriteAllText(outPath, json);
			else Console.Out.Write(json);
			return 0;
		}

		// ---- static helpers ---------------------------------------------------

		static void CollectCs(string dir, List<string> outList)
		{
			IEnumerable<string> entries;
			try { entries = Directory.EnumerateFileSystemEntries(dir); } catch { return; }
			foreach (var e in entries)
			{
				var name = Path.GetFileName(e);
				if (Directory.Exists(e)) { if (!NoiseDirs.Contains(name)) CollectCs(e, outList); }
				else if (name.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) && !name.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase) && !name.EndsWith(".g.i.cs", StringComparison.OrdinalIgnoreCase))
					outList.Add(e);
			}
		}

		static IEnumerable<INamedTypeSymbol> AllTypes(Compilation comp)
		{
			var stack = new Stack<INamespaceOrTypeSymbol>();
			stack.Push(comp.GlobalNamespace);
			while (stack.Count > 0)
			{
				var cur = stack.Pop();
				foreach (var m in cur.GetMembers())
				{
					if (m is INamespaceSymbol ns) stack.Push(ns);
					else if (m is INamedTypeSymbol t) { yield return t; foreach (var nested in t.GetTypeMembers()) stack.Push(nested); }
				}
			}
		}

		static bool IsDispatch(IMethodSymbol m)
			=> m.IsVirtual || m.IsAbstract || m.IsOverride || m.ContainingType?.TypeKind == TypeKind.Interface;

		// Class-hierarchy analysis: source methods that override or implement `target`.
		static IEnumerable<IMethodSymbol> DispatchTargets(IMethodSymbol target, List<INamedTypeSymbol> allTypes)
		{
			target = target.OriginalDefinition;
			var seen = new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default);
			bool isIface = target.ContainingType?.TypeKind == TypeKind.Interface;
			foreach (var type in allTypes)
			{
				if (type.TypeKind == TypeKind.Interface) continue;
				if (isIface)
				{
					bool implementsIface = type.AllInterfaces.Any(i => SymbolEqualityComparer.Default.Equals(i.OriginalDefinition, target.ContainingType.OriginalDefinition));
					if (implementsIface && type.FindImplementationForInterfaceMember(target) is IMethodSymbol impl
						&& impl.DeclaringSyntaxReferences.Any() && seen.Add(impl)) yield return impl;
				}
				foreach (var m in type.GetMembers().OfType<IMethodSymbol>())
				{
					if (!m.IsOverride || !m.DeclaringSyntaxReferences.Any()) continue;
					for (var o = m.OverriddenMethod; o != null; o = o.OverriddenMethod)
						if (SymbolEqualityComparer.Default.Equals(o.OriginalDefinition, target)) { if (seen.Add(m)) yield return m; break; }
				}
			}
		}

		static IEventSymbol EventOf(InvocationExpressionSyntax inv, SemanticModel model)
		{
			ExpressionSyntax recv = null;
			if (inv.Expression is MemberAccessExpressionSyntax ma && ma.Name.Identifier.Text == "Invoke") recv = ma.Expression;
			else if (inv.Expression is MemberBindingExpressionSyntax mb && mb.Name.Identifier.Text == "Invoke")
				recv = inv.Ancestors().OfType<ConditionalAccessExpressionSyntax>().FirstOrDefault()?.Expression;
			else recv = inv.Expression; // direct: SomeEvent(...)
			return recv == null ? null : model.GetSymbolInfo(recv).Symbol as IEventSymbol;
		}

		static bool InParallel(SyntaxNode n)
		{
			for (var a = n.Parent; a != null; a = a.Parent)
			{
				if (a is InvocationExpressionSyntax outer && outer != n)
				{
					string name = outer.Expression is MemberAccessExpressionSyntax m ? m.Name.Identifier.Text
						: outer.Expression is MemberBindingExpressionSyntax mb ? mb.Name.Identifier.Text : null;
					string recv = (outer.Expression as MemberAccessExpressionSyntax)?.Expression?.ToString();
					if (name == "WhenAll" || name == "WhenAny" || name == "Run" || name == "Invoke" || name == "For" || name == "ForEach")
						if (recv == null || recv.EndsWith("Task") || recv.EndsWith("Parallel"))
							return true;
				}
			}
			return false;
		}
	}
}
