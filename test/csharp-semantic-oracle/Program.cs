// Roslyn semantic caller oracle (Part C, C0a-2): every call edge in a repository's non-test
// projects, bound by Roslyn (MSBuildWorkspace), callers and targets keyed per C-D6 with the
// syntax oracle's own key function (Oracle.MembersOf, compiled in from
// ../csharp-syntax-oracle/Program.cs). Output format: README.md beside this file.
// Usage: dotnet SemanticOracle.dll <repo> <solution (.slnx/.sln) or project> <out.json>
// The repository must be restored (`dotnet restore`); nothing is built or run.
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Operations;

static class SemanticOracle
{
    static readonly Regex TestProject = new(@"(^|/)tests?/|\.Tests?\.csproj$", RegexOptions.IgnoreCase);

    static string repo = "";

    /// Per file (repo-relative path): member keys by name offset (the syntax oracle's members),
    /// the top-level key, and the BOM shift (disk text has the BOM removed; offsets in the
    /// output count it, as the syntax oracle and JavaScript do).
    sealed class FileKeys
    {
        public Dictionary<int, string> ByNameOffset = new();
        public string? TopLevel;
        public int Bom;
    }

    static readonly Dictionary<string, FileKeys> files = new(StringComparer.Ordinal);

    static int Main(string[] args)
    {
        if (args.Length != 3) { Console.Error.WriteLine("usage: SemanticOracle <repo> <solution|project> <out.json>"); return 2; }
        return Run(Path.GetFullPath(args[0]), Path.GetFullPath(args[1]), args[2]).GetAwaiter().GetResult();
    }

    static async Task<int> Run(string repoArg, string entry, string outPath)
    {
        repo = repoArg.TrimEnd('/');
        var total = Stopwatch.StartNew();
        var commit = Git("rev-parse", "HEAD").Trim();
        var dirty = Git("status", "--porcelain", "--untracked-files=no").Trim().Length > 0;

        // ---- open ---------------------------------------------------------------------------
        var sw = Stopwatch.StartNew();
        var all = ProjectsOf(entry);
        var wanted = all.Where(p => !TestProject.IsMatch(Rel(p))).ToList();
        var excluded = all.Except(wanted).Select(Rel).ToList();
        var workspaceDiags = new List<string>();
        using var ws = MSBuildWorkspace.Create();
        ws.RegisterWorkspaceFailedHandler(e => workspaceDiags.Add($"{e.Diagnostic.Kind}: {e.Diagnostic.Message}"));
        foreach (var p in wanted)
        {
            if (ws.CurrentSolution.Projects.Any(x => string.Equals(x.FilePath, p, StringComparison.Ordinal))) continue;
            await ws.OpenProjectAsync(p);
        }
        var openMs = sw.ElapsedMilliseconds;
        var projects = ws.CurrentSolution.Projects.Where(p => p.Language == LanguageNames.CSharp).ToList();
        Console.Error.WriteLine($"open: {projects.Count} projects in {openMs} ms ({workspaceDiags.Count} workspace diagnostics)");

        // ---- compile (declarations, source generators) -------------------------------------
        sw.Restart();
        var comps = new List<(Project project, Compilation comp)>();
        int declErrors = 0;
        var errorSample = new List<string>();
        foreach (var p in projects)
        {
            var c = (await p.GetCompilationAsync())!;
            var errs = c.GetDeclarationDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
            declErrors += errs.Count;
            foreach (var d in errs.Take(3)) if (errorSample.Count < 30) errorSample.Add($"{p.Name}: {d}");
            comps.Add((p, c));
        }
        var compileMs = sw.ElapsedMilliseconds;
        Console.Error.WriteLine($"compile: {comps.Count} compilations in {compileMs} ms ({declErrors} declaration errors)");

        // ---- bind and walk -----------------------------------------------------------------
        sw.Restart();
        var edges = new List<Edge>();
        var counts = new SortedDictionary<string, int>(StringComparer.Ordinal);
        int bindErrors = 0, docs = 0;
        var projectRows = new List<(string name, string path, int docs, int errors)>();
        var seenPaths = new HashSet<string>(StringComparer.Ordinal);
        var impls = new SortedDictionary<string, SortedSet<string>>(StringComparer.Ordinal);  // "file|key" of an interface member → impl ids
        var overrides = new SortedDictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        unkeyedImpls.Clear();
        // Keys first for every in-repo file of every compilation (targets may live in any of them).
        foreach (var (_, c) in comps)
            foreach (var tree in c.SyntaxTrees)
            {
                var rel = InRepo(tree.FilePath);
                if (rel == null || files.ContainsKey(rel)) continue;
                var fk = new FileKeys();
                using (var fs = File.OpenRead(tree.FilePath))
                {
                    var b = new byte[3];
                    fk.Bom = fs.Read(b, 0, 3) == 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF ? 1 : 0;
                }
                foreach (var m in Oracle.MembersOf((CompilationUnitSyntax)tree.GetRoot(), rel))
                {
                    if (m.Kind == "top-level") fk.TopLevel = m.Key;
                    else fk.ByNameOffset[m.NameOffset] = m.Key;
                }
                files[rel] = fk;
            }
        foreach (var (p, c) in comps)
        {
            var keyer = new Keyer(c);
            int pdocs = 0, perr = 0;
            foreach (var tree in c.SyntaxTrees)
            {
                var rel = InRepo(tree.FilePath);
                if (rel == null || !seenPaths.Add(rel)) continue;
                pdocs++;
                var model = c.GetSemanticModel(tree);
                perr += model.GetDiagnostics().Count(d => d.Severity == DiagnosticSeverity.Error);
                Walk(tree, rel, model, keyer, edges, counts);
            }
            Relations(c, keyer, impls, overrides);
            docs += pdocs; bindErrors += perr;
            projectRows.Add((p.Name, Rel(p.FilePath!), pdocs, perr));
        }
        foreach (var e in edges)
        {
            var id = e.TargetFile + "|" + e.Target;
            if (e.Via == "interface")
            {
                e.Implementations = impls.TryGetValue(id, out var s) ? s.Count : 0;
                if (unkeyedImpls.TryGetValue(id, out var u)) e.UnkeyedImplementations = u;
            }
            else if (e.Via == null && e.Virtual && overrides.TryGetValue(id, out var o) && o.Count > 0) { e.Via = "override-base"; e.Overrides = o.Count; }
        }
        var bindMs = sw.ElapsedMilliseconds;
        Console.Error.WriteLine($"bind: {docs} files, {edges.Count} edges in {bindMs} ms ({bindErrors} errors)");

        // ---- output ------------------------------------------------------------------------
        using (var stream = File.Create(outPath))
        using (var w = new Utf8JsonWriter(stream))
        {
            w.WriteStartObject();
            w.WriteString("oracle", "csharp-semantic");
            w.WriteString("roslyn", typeof(CSharpSyntaxTree).Assembly.GetName().Version?.ToString() ?? "?");
            w.WriteString("commit", commit);
            w.WriteBoolean("dirty", dirty);
            w.WriteString("entry", Rel(entry));
            w.WriteStartObject("timings");
            w.WriteNumber("openMs", openMs); w.WriteNumber("compileMs", compileMs); w.WriteNumber("bindMs", bindMs);
            w.WriteNumber("totalMs", total.ElapsedMilliseconds);
            w.WriteEndObject();
            w.WriteStartArray("projects");
            foreach (var r in projectRows)
            {
                w.WriteStartObject();
                w.WriteString("name", r.name); w.WriteString("path", r.path); w.WriteNumber("files", r.docs); w.WriteNumber("errors", r.errors);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteStartArray("excludedProjects"); foreach (var x in excluded) w.WriteStringValue(x); w.WriteEndArray();
            w.WriteStartObject("diagnostics");
            w.WriteStartArray("workspace"); foreach (var d in workspaceDiags) w.WriteStringValue(d); w.WriteEndArray();
            w.WriteNumber("declarationErrors", declErrors);
            w.WriteNumber("bindErrors", bindErrors);
            w.WriteStartArray("errorSample"); foreach (var d in errorSample) w.WriteStringValue(d); w.WriteEndArray();
            w.WriteEndObject();
            w.WriteStartObject("skipped"); foreach (var (k, v) in counts) w.WriteNumber(k, v); w.WriteEndObject();
            w.WriteStartArray("edges");
            foreach (var e in edges) e.Write(w);
            w.WriteEndArray();
            Relation(w, "interfaces", "implementations", impls, unkeyedImpls);
            Relation(w, "overrides", "overrides", overrides);
            w.WriteEndObject();
        }
        Console.Error.WriteLine($"total {total.ElapsedMilliseconds} ms; peak working set {Process.GetCurrentProcess().PeakWorkingSet64 >> 20} MiB");
        return 0;
    }

    /// Interface member id → implementing members with no key (an auto-property implementing an interface property).
    static readonly SortedDictionary<string, int> unkeyedImpls = new(StringComparer.Ordinal);

    static void Relation(Utf8JsonWriter w, string name, string field, SortedDictionary<string, SortedSet<string>> map, SortedDictionary<string, int>? unkeyed = null)
    {
        w.WriteStartArray(name);
        var ids = unkeyed == null ? map.Keys.ToList() : map.Keys.Union(unkeyed.Keys).OrderBy(k => k, StringComparer.Ordinal).ToList();
        foreach (var id in ids)
        {
            var set = map.TryGetValue(id, out var ms) ? ms : new SortedSet<string>();
            w.WriteStartObject();
            var bar = id.IndexOf('|');
            w.WriteString("member", id[(bar + 1)..]); w.WriteString("file", id[..bar]);
            w.WriteStartArray(field);
            foreach (var s in set)
            {
                var b = s.IndexOf('|');
                w.WriteStartObject(); w.WriteString("key", s[(b + 1)..]); w.WriteString("file", s[..b]); w.WriteEndObject();
            }
            w.WriteEndArray();
            if (unkeyed != null && unkeyed.TryGetValue(id, out var n)) w.WriteNumber("unkeyedImplementations", n);
            w.WriteEndObject();
        }
        w.WriteEndArray();
    }

    // ---- edges ---------------------------------------------------------------------------

    sealed class Edge
    {
        public string? Caller, CallerContext;
        public string Target = "", TargetFile = "", Kind = "", File = "";
        public int Start, End, Line;
        public string? Via;
        public bool Virtual;
        public int Implementations = -1, Overrides = -1, UnkeyedImplementations = -1;

        public void Write(Utf8JsonWriter w)
        {
            w.WriteStartObject();
            if (Caller != null) w.WriteString("caller", Caller); else w.WriteNull("caller");
            if (CallerContext != null) w.WriteString("callerContext", CallerContext);
            w.WriteString("target", Target); w.WriteString("targetFile", TargetFile);
            w.WriteString("kind", Kind);
            w.WriteString("file", File); w.WriteNumber("start", Start); w.WriteNumber("end", End); w.WriteNumber("line", Line);
            if (Via != null) w.WriteString("via", Via);
            if (Implementations >= 0) w.WriteNumber("implementations", Implementations);
            if (UnkeyedImplementations > 0) w.WriteNumber("unkeyedImplementations", UnkeyedImplementations);
            if (Overrides >= 0) w.WriteNumber("overrides", Overrides);
            w.WriteEndObject();
        }
    }

    static void Walk(SyntaxTree tree, string rel, SemanticModel model, Keyer keyer, List<Edge> edges, SortedDictionary<string, int> counts)
    {
        var fk = files[rel];
        void Count(string k) => counts[k] = counts.GetValueOrDefault(k) + 1;
        void Add(SyntaxNode site, TextSpan_ span, ISymbol? sym, string kind, bool baseCall, bool isVirtualCall)
        {
            if (sym == null) { Count("unresolved"); return; }
            var t = keyer.Target(sym, out var why);
            if (t == null) { Count(why); return; }
            var (callerKey, ctx) = CallerOf(site, fk);
            var e = new Edge
            {
                Caller = callerKey, CallerContext = ctx, Target = t.Value.key, TargetFile = t.Value.file, Kind = kind, File = rel,
                Start = span.Start + fk.Bom, End = span.End + fk.Bom,
                Line = tree.GetLineSpan(new Microsoft.CodeAnalysis.Text.TextSpan(span.Start, 0)).StartLinePosition.Line + 1,
            };
            var s = sym is IMethodSymbol { ReducedFrom: { } r } ? r : sym;
            if (!s.IsStatic && s.ContainingType?.TypeKind == TypeKind.Interface && !baseCall) e.Via = "interface";
            else e.Virtual = !baseCall && isVirtualCall && (s.IsVirtual || s.IsAbstract || s.IsOverride);
            edges.Add(e);
        }

        foreach (var node in tree.GetRoot().DescendantNodes())
        {
            switch (node)
            {
                case InvocationExpressionSyntax inv:
                {
                    var op = model.GetOperation(inv);
                    if (op is IInvocationOperation io)
                    {
                        if (io.TargetMethod.MethodKind == MethodKind.DelegateInvoke) { Count("delegate-invoke"); break; }
                        Add(inv, NameSpan(inv.Expression), io.TargetMethod, "invocation", IsBase(inv.Expression), io.IsVirtual);
                    }
                    else if (op is INameOfOperation) Count("nameof");
                    else if (op is IDynamicInvocationOperation) Count("dynamic");
                    else if (op == null || op is IInvalidOperation) Count("unresolved");
                    break;
                }
                case BaseObjectCreationExpressionSyntax oc:
                {
                    var op = model.GetOperation(oc);
                    if (op is IObjectCreationOperation co)
                    {
                        if (co.Constructor == null) { Count("unresolved"); break; }
                        var span = oc is ObjectCreationExpressionSyntax o ? NameSpan(o.Type) : new TextSpan_(oc.NewKeyword.Span.Start, oc.NewKeyword.Span.End);
                        Add(oc, span, co.Constructor, "object-creation", false, false);
                    }
                    else if (op is IDelegateCreationOperation) Count("delegate-creation");
                    else if (op is ITypeParameterObjectCreationOperation) Count("type-parameter-new");
                    else if (op is IDynamicObjectCreationOperation) Count("dynamic");
                    else Count("unresolved");
                    break;
                }
                case ConstructorInitializerSyntax ci:
                    Add(ci, new TextSpan_(ci.ThisOrBaseKeyword.Span.Start, ci.ThisOrBaseKeyword.Span.End),
                        model.GetSymbolInfo(ci).Symbol, "initializer", false, false);
                    break;
                case PrimaryConstructorBaseTypeSyntax pb:
                    Add(pb, NameSpan(pb.Type), model.GetSymbolInfo(pb).Symbol, "initializer", false, false);
                    break;
                case MemberAccessExpressionSyntax or MemberBindingExpressionSyntax or SimpleNameSyntax
                    or ElementAccessExpressionSyntax or ElementBindingExpressionSyntax:
                {
                    var expr = (ExpressionSyntax)node;
                    // A simple name that is the right side of `a.B` / `?.B` is handled by its parent.
                    if (node is SimpleNameSyntax && node.Parent is MemberAccessExpressionSyntax ma && ma.Name == node) break;
                    if (node is SimpleNameSyntax && node.Parent is MemberBindingExpressionSyntax) break;
                    if (node.Parent is InvocationExpressionSyntax pi && pi.Expression == node) break; // the call itself
                    var op = model.GetOperation(expr);
                    if (op == null) break;
                    if (InNameOf(op)) { Count("nameof"); break; }
                    if (op is IPropertyReferenceOperation pr)
                    {
                        var span = node is ElementAccessExpressionSyntax ea ? Span(ea.ArgumentList.Span)
                            : node is ElementBindingExpressionSyntax eb ? Span(eb.ArgumentList.Span) : NameSpan(expr);
                        var baseCall = node is MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax }
                            || node is ElementAccessExpressionSyntax { Expression: BaseExpressionSyntax };
                        foreach (var kind in Access(pr))
                            Add(node, span, pr.Property, kind, baseCall, pr.Instance != null);
                    }
                    else if (op is IMethodReferenceOperation mr)
                    {
                        Add(node, NameSpan(expr), mr.Method, "method-group", IsBase(expr), mr.IsVirtual);
                    }
                    break;
                }
            }
        }
    }

    readonly record struct TextSpan_(int Start, int End);

    static TextSpan_ Span(Microsoft.CodeAnalysis.Text.TextSpan s) => new(s.Start, s.End);

    /// The name a call site points at: `b` in `a.b(…)`, `?.b`, `a.b<T>`, the type's last name in `new N.T()`.
    static TextSpan_ NameSpan(SyntaxNode e) => e switch
    {
        MemberAccessExpressionSyntax m => NameSpan(m.Name),
        MemberBindingExpressionSyntax b => NameSpan(b.Name),
        QualifiedNameSyntax q => NameSpan(q.Right),
        AliasQualifiedNameSyntax a => NameSpan(a.Name),
        SimpleNameSyntax s => Span(s.Identifier.Span),
        _ => Span(e.Span),
    };

    static bool IsBase(ExpressionSyntax e) => e is MemberAccessExpressionSyntax { Expression: BaseExpressionSyntax };

    static bool InNameOf(IOperation op)
    {
        for (var p = op.Parent; p != null; p = p.Parent) if (p is INameOfOperation) return true;
        return false;
    }

    /// property-get / property-set (both for `+=`, `++`, and a ref use is a get).
    static IEnumerable<string> Access(IPropertyReferenceOperation pr)
    {
        var parent = pr.Parent;
        if (parent is ISimpleAssignmentOperation sa && sa.Target == pr) { yield return "property-set"; yield break; }
        if (parent is IDeconstructionAssignmentOperation) { yield return "property-set"; yield break; }
        if (parent is ITupleOperation { Parent: IDeconstructionAssignmentOperation }) { yield return "property-set"; yield break; }
        if ((parent is ICompoundAssignmentOperation ca && ca.Target == pr) || (parent is ICoalesceAssignmentOperation cc && cc.Target == pr)
            || parent is IIncrementOrDecrementOperation)
        { yield return "property-get"; yield return "property-set"; yield break; }
        yield return "property-get";
    }

    /// The member a call site belongs to (lambdas and local functions belong to their member).
    static (string? key, string? context) CallerOf(SyntaxNode site, FileKeys fk)
    {
        for (var n = site.Parent; n != null; n = n.Parent)
        {
            switch (n)
            {
                case GlobalStatementSyntax: return (fk.TopLevel, null);
                case MethodDeclarationSyntax m: return Lookup(fk, m.Identifier.SpanStart, "method");
                case ConstructorDeclarationSyntax c: return Lookup(fk, c.Identifier.SpanStart, "constructor");
                case OperatorDeclarationSyntax o: return Lookup(fk, o.OperatorKeyword.SpanStart, "operator");
                case ConversionOperatorDeclarationSyntax cv: return Lookup(fk, cv.OperatorKeyword.SpanStart, "conversion");
                case DestructorDeclarationSyntax: return (null, "finalizer");
                case PropertyDeclarationSyntax p: return Lookup(fk, p.Identifier.SpanStart, "property-initializer");
                case IndexerDeclarationSyntax ix: return Lookup(fk, ix.ThisKeyword.SpanStart, "indexer");
                case EventDeclarationSyntax: return (null, "event-accessor");
                case BaseFieldDeclarationSyntax: return (null, "field-initializer");
                case EnumMemberDeclarationSyntax: return (null, "enum-member");
                case AttributeSyntax: return (null, "attribute");
                case PrimaryConstructorBaseTypeSyntax: case ParameterListSyntax { Parent: TypeDeclarationSyntax }:
                    var t = n.FirstAncestorOrSelf<TypeDeclarationSyntax>()!;
                    return Lookup(fk, t.Identifier.SpanStart, "primary-constructor");
                case BaseTypeDeclarationSyntax: return (null, "type");
            }
        }
        return (null, "file");
    }

    static (string?, string?) Lookup(FileKeys fk, int nameOffset, string what) =>
        fk.ByNameOffset.TryGetValue(nameOffset, out var k) ? (k, null) : (null, what + "-not-a-member");

    // ---- symbol → key --------------------------------------------------------------------

    sealed class Keyer(Compilation comp)
    {
        readonly Dictionary<ISymbol, (string key, string file)?> cache = new(SymbolEqualityComparer.Default);
        readonly Dictionary<ISymbol, string> whyNot = new(SymbolEqualityComparer.Default);

        /// The in-repo member a bound symbol stands for: its original definition (an extension
        /// method's static method, a generic member's definition), keyed by its declaration.
        public (string key, string file)? Target(ISymbol sym, out string why)
        {
            why = "";
            if (sym is IMethodSymbol m)
            {
                if (m.ReducedFrom != null) m = m.ReducedFrom;
                if (m.MethodKind is MethodKind.LocalFunction) { why = "local-function"; return null; }
                if (m.MethodKind is MethodKind.AnonymousFunction) { why = "lambda"; return null; }
                if (m.MethodKind is MethodKind.PropertyGet or MethodKind.PropertySet && m.AssociatedSymbol != null) sym = m.AssociatedSymbol;
                else sym = m.PartialDefinitionPart ?? m;
            }
            sym = sym.OriginalDefinition;
            if (cache.TryGetValue(sym, out var hit)) { why = hit == null ? whyNot[sym] : ""; return hit; }
            var r = Compute(sym, out why);
            cache[sym] = r;
            if (r == null) whyNot[sym] = why;
            return r;
        }

        static (string key, string file)? Compute(ISymbol sym, out string why)
        {
            why = "external";
            if (sym.DeclaringSyntaxReferences.Length == 0) { why = sym.Locations.Any(l => l.IsInSource) ? "implicit" : "external"; return null; }
            foreach (var r in sym.DeclaringSyntaxReferences)
            {
                var rel = InRepo(r.SyntaxTree.FilePath);
                if (rel == null) { why = r.SyntaxTree.FilePath.Contains("/obj/", StringComparison.Ordinal) || !r.SyntaxTree.FilePath.StartsWith(repo, StringComparison.Ordinal) ? "generated-or-external" : "external"; continue; }
                if (!files.TryGetValue(rel, out var fk)) { why = "file-not-keyed"; continue; }
                var node = r.GetSyntax();
                int? off = node switch
                {
                    MethodDeclarationSyntax md => md.Identifier.SpanStart,
                    ConstructorDeclarationSyntax cd => cd.Identifier.SpanStart,
                    OperatorDeclarationSyntax od => od.OperatorKeyword.SpanStart,
                    ConversionOperatorDeclarationSyntax cv => cv.OperatorKeyword.SpanStart,
                    PropertyDeclarationSyntax pd => pd.Identifier.SpanStart,
                    IndexerDeclarationSyntax ix => ix.ThisKeyword.SpanStart,
                    TypeDeclarationSyntax td => td.Identifier.SpanStart, // primary constructor
                    _ => null,
                };
                if (off is int o && fk.ByNameOffset.TryGetValue(o, out var key)) return (key, rel);
                // Not C-D4 members (no key): reported by reason in "skipped" (body-less interface and abstract
                // properties and indexers are members now, keyed by the syntax oracle).
                why = node switch
                {
                    PropertyDeclarationSyntax when sym.ContainingType?.TypeKind == TypeKind.Interface => "interface-property-without-body",
                    PropertyDeclarationSyntax when sym.IsAbstract => "abstract-property",
                    PropertyDeclarationSyntax => "auto-property",
                    IndexerDeclarationSyntax => "indexer-without-body",
                    ParameterSyntax => "record-property",
                    AnonymousObjectMemberDeclaratorSyntax => "anonymous-type-property",
                    _ => "not-a-member:" + node.Kind(),
                };
            }
            return null;
        }

        public Compilation Compilation => comp;
    }

    /// Interface member → in-repo implementations, overridden member → in-repo overrides
    /// (transitive), for the types declared in this compilation's in-repo files.
    static void Relations(Compilation c, Keyer keyer, SortedDictionary<string, SortedSet<string>> impls, SortedDictionary<string, SortedSet<string>> overrides)
    {
        static string Id((string key, string file) t) => t.file + "|" + t.key;
        void AddTo(SortedDictionary<string, SortedSet<string>> map, string k, string v)
        {
            if (!map.TryGetValue(k, out var s)) map[k] = s = new SortedSet<string>(StringComparer.Ordinal);
            s.Add(v);
        }
        foreach (var type in Types(c.Assembly.GlobalNamespace))
        {
            if (!type.Locations.Any(l => l.IsInSource && InRepo(l.SourceTree!.FilePath) != null)) continue;
            if (type.TypeKind is not (TypeKind.Class or TypeKind.Struct)) continue;
            foreach (var iface in type.AllInterfaces)
                foreach (var m in iface.GetMembers())
                {
                    if (m.IsStatic && !m.IsAbstract && !m.IsVirtual) continue;
                    if (m is not (IMethodSymbol { MethodKind: MethodKind.Ordinary } or IPropertySymbol)) continue;
                    var ik = keyer.Target(m, out _);
                    if (ik == null) continue;
                    var impl = type.FindImplementationForInterfaceMember(m);
                    if (impl == null) continue;
                    var mk = keyer.Target(impl, out _);
                    if (mk != null) AddTo(impls, Id(ik.Value), Id(mk.Value));
                    else if (impl.DeclaringSyntaxReferences.Length > 0 && impl.DeclaringSyntaxReferences.Any(r => InRepo(r.SyntaxTree.FilePath) != null))
                        unkeyedImpls[Id(ik.Value)] = unkeyedImpls.GetValueOrDefault(Id(ik.Value)) + 1; // auto-property: not a member
                }
            foreach (var m in type.GetMembers())
            {
                if (!m.IsOverride) continue;
                var mk = keyer.Target(m, out _);
                if (mk == null) continue;
                for (ISymbol? b = Overridden(m); b != null; b = Overridden(b))
                {
                    var bk = keyer.Target(b, out _);
                    if (bk != null) AddTo(overrides, Id(bk.Value), Id(mk.Value));
                }
            }
        }
    }

    static ISymbol? Overridden(ISymbol m) => m switch
    {
        IMethodSymbol ms => ms.OverriddenMethod,
        IPropertySymbol ps => ps.OverriddenProperty,
        _ => null,
    };

    static IEnumerable<INamedTypeSymbol> Types(INamespaceOrTypeSymbol ns)
    {
        foreach (var m in ns.GetMembers())
        {
            if (m is INamespaceSymbol n) foreach (var t in Types(n)) yield return t;
            else if (m is INamedTypeSymbol t)
            {
                yield return t;
                foreach (var inner in Types(t)) yield return inner;
            }
        }
    }

    // ---- files and projects --------------------------------------------------------------

    /// Repo-relative path of an in-repo source file, null outside the repo or under bin/obj.
    static string? InRepo(string? path)
    {
        if (string.IsNullOrEmpty(path) || !path.StartsWith(repo + "/", StringComparison.Ordinal)) return null;
        var rel = path[(repo.Length + 1)..];
        if (!rel.EndsWith(".cs", StringComparison.Ordinal)) return null;
        if (rel.Split('/').SkipLast(1).Any(s => s == "bin" || s == "obj")) return null;
        return rel;
    }

    static string Rel(string p) => p.StartsWith(repo + "/", StringComparison.Ordinal) ? p[(repo.Length + 1)..] : p;

    /// The `.csproj` files of a solution (`.slnx` or `.sln`), or the project itself.
    static List<string> ProjectsOf(string entry)
    {
        var dir = Path.GetDirectoryName(entry)!;
        IEnumerable<string> rels;
        if (entry.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase))
            rels = XDocument.Load(entry).Descendants("Project").Select(e => (string?)e.Attribute("Path")).OfType<string>();
        else if (entry.EndsWith(".sln", StringComparison.OrdinalIgnoreCase))
            rels = Regex.Matches(File.ReadAllText(entry), "\"([^\"]+\\.csproj)\"").Select(m => m.Groups[1].Value);
        else return new() { entry };
        return rels.Where(r => r.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            .Select(r => Path.GetFullPath(Path.Combine(dir, r.Replace('\\', '/')))).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList();
    }

    static string Git(params string[] args)
    {
        var psi = new ProcessStartInfo("git") { RedirectStandardOutput = true, UseShellExecute = false };
        psi.ArgumentList.Add("-C"); psi.ArgumentList.Add(repo);
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        var s = p.StandardOutput.ReadToEnd();
        p.WaitForExit();
        return s;
    }
}
