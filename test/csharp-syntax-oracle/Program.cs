// Roslyn syntax oracle (Part C, C0a-1): every C-D4 member of every .cs file of a repository at
// one commit, keyed per C-D6, as one JSON document. Parse only (CSharpSyntaxTree.ParseText at
// LanguageVersion.Preview, no references, no preprocessor symbols): nothing of the repository is
// built or run. Files are read from git objects (`git ls-tree`, `git cat-file --batch`), so the
// working tree is never touched. Output format: README.md beside this file.
// Usage: dotnet SyntaxOracle.dll <repo> <commit> <out.json>
//        dotnet SyntaxOracle.dll <repo> --list=<file> <out.json>   (lines `<commit>:<path>`)
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

static class Oracle
{
    static int Main(string[] args)
    {
        if (args.Length != 3) { Console.Error.WriteLine("usage: SyntaxOracle <repo> <commit>|--list=<file> <out.json>"); return 2; }
        var (repo, outPath) = (args[0], args[2]);
        string sha;
        List<(string path, string blob, string commit)> files;
        if (args[1].StartsWith("--list=", StringComparison.Ordinal))
        {
            // Named files only: one `<commit>:<path>` per line (the PR mode of csharp-verify.js).
            sha = "";
            files = File.ReadAllLines(args[1]["--list=".Length..]).Where(l => l.Length > 0).Select(l =>
            {
                var c = l.IndexOf(':');
                return (l[(c + 1)..], l, l[..c]);
            }).ToList();
        }
        else
        {
            sha = Git(repo, "rev-parse", args[1] + "^{commit}").Trim();
            files = ListCs(repo, sha).Select(f => (f.path, f.blob, sha)).ToList();
        }
        var texts = ReadBlobs(repo, files.Select(f => f.blob).ToList());
        var options = new CSharpParseOptions(LanguageVersion.Preview);
        var roslyn = typeof(CSharpSyntaxTree).Assembly.GetName().Version?.ToString() ?? "?";
        using var stream = File.Create(outPath);
        using var w = new Utf8JsonWriter(stream);
        w.WriteStartObject();
        w.WriteString("oracle", "csharp-syntax");
        w.WriteString("roslyn", roslyn);
        w.WriteString("languageVersion", "Preview");
        if (sha.Length > 0) w.WriteString("commit", sha);
        w.WriteStartArray("files");
        for (int i = 0; i < files.Count; i++)
        {
            var text = texts[i];
            var tree = CSharpSyntaxTree.ParseText(text, options);
            var root = (CompilationUnitSyntax)tree.GetRoot();
            var members = MembersOf(root, files[i].path);
            var globals = root.Members.OfType<GlobalStatementSyntax>().ToList();
            w.WriteStartObject();
            w.WriteString("path", files[i].path);
            if (sha.Length == 0) w.WriteString("commit", files[i].commit);
            w.WriteNumber("diagnostics", tree.GetDiagnostics().Count(d => d.Severity == DiagnosticSeverity.Error));
            w.WriteBoolean("topLevelStatements", globals.Count > 0);
            w.WriteBoolean("hasIf", root.ContainsDirectives && root.DescendantTrivia().Any(t => t.IsKind(SyntaxKind.IfDirectiveTrivia)));
            w.WriteStartArray("members");
            foreach (var m in members) Write(w, m, tree);
            w.WriteEndArray();
            w.WriteEndObject();
        }
        w.WriteEndArray();
        w.WriteEndObject();
        return 0;
    }

    /// The C-D4 members of one file with their C-D6 keys, in source order (top-level first).
    /// Shared with the semantic oracle (test/csharp-semantic-oracle), so both key alike.
    internal static List<Member> MembersOf(CompilationUnitSyntax root, string path)
    {
        var members = new List<Member>();
        var globals = root.Members.OfType<GlobalStatementSyntax>().ToList();
        if (globals.Count > 0)
        {
            var name = Path.GetFileName(path);
            members.Add(new Member
            {
                Kind = "top-level", Key = name, Name = name,
                NameOffset = globals[0].SpanStart, Start = globals[0].SpanStart, End = globals[^1].Span.End,
            });
        }
        Walk(root.Members, "", members, null);
        Number(members);
        return members;
    }

    internal sealed class Param
    {
        public string Name = "", Type = "", KeyType = "";
        public List<string> Modifiers = new(), Attributes = new();
        public string? Default;
    }

    internal sealed class Member
    {
        public string Kind = "", Key = "", Name = "", Container = "";
        public string? ExplicitInterface, Returns, Header, Body;
        public int NameOffset, Start, End;
        public List<string> Modifiers = new(), Attributes = new(), TypeParameters = new();
        public List<Param> Params = new();
    }

    // ---- walking ------------------------------------------------------------------------

    /// A C# 14 `extension(T x) { … }` block around a member: the receiver as a key parameter
    /// (`this T`) and the block's type-parameter count.
    internal sealed record Ext(string Receiver, int Arity);

    static void Walk(SyntaxList<MemberDeclarationSyntax> list, string path, List<Member> into, Ext? ext)
    {
        foreach (var node in list)
        {
            switch (node)
            {
                case BaseNamespaceDeclarationSyntax ns: Walk(ns.Members, path, into, null); break;
                case TypeDeclarationSyntax t when t.Kind().ToString() == "ExtensionBlockDeclaration":
                    // C# 14 `extension(T x) { … }`: not a type, its members belong to the static class
                    // and an instance member is keyed as the classic extension method (owner decision
                    // after the C0–C2 review): `this T` first, the block's type parameters added to
                    // the method's arity.
                    var recv = t.ParameterList?.Parameters.FirstOrDefault();
                    var block = new Ext(recv == null ? "" : "this " + KeyType(recv), t.TypeParameterList?.Parameters.Count ?? 0);
                    Walk(t.Members, path, into, block); break;
                case TypeDeclarationSyntax t:
                    var seg = t.Identifier.ValueText + Arity(t.TypeParameterList);
                    var inner = path.Length == 0 ? seg : path + "." + seg;
                    if (t.ParameterList != null) into.Add(PrimaryCtor(t, inner));
                    Walk(t.Members, inner, into, null);
                    break;
                case BaseMethodDeclarationSyntax or BasePropertyDeclarationSyntax:
                    var m = MemberOf(node, path, ext);
                    if (m != null) into.Add(m);
                    break;
            }
        }
    }

    static string Arity(TypeParameterListSyntax? tp) => tp == null || tp.Parameters.Count == 0 ? "" : $"<{tp.Parameters.Count}>";

    static Member PrimaryCtor(TypeDeclarationSyntax t, string path)
    {
        var m = new Member { Kind = "primary-constructor", Name = t.Identifier.ValueText, NameOffset = t.Identifier.SpanStart, Container = path };
        m.Start = t.ParameterList!.SpanStart;
        m.End = t.ParameterList.Span.End;
        m.Params = ParamsOf(t.ParameterList.Parameters);
        m.Header = Normalise(t.Identifier, t.ParameterList.GetLastToken());
        m.Key = $"{path}.<init>({KeyParams(m.Params)})";
        return m;
    }

    static Member? MemberOf(MemberDeclarationSyntax node, string path, Ext? ext)
    {
        var m = new Member { Container = path, Start = node.SpanStart, End = node.Span.End };
        m.Modifiers = node.Modifiers.Select(x => x.Text).ToList();
        m.Attributes = node.AttributeLists.Select(a => a.ToString()).ToList();
        string? iface = null;
        switch (node)
        {
            case MethodDeclarationSyntax md:
                m.Kind = "method"; m.Name = md.Identifier.ValueText; m.NameOffset = md.Identifier.SpanStart;
                m.Returns = md.ReturnType.ToString(); m.Params = ParamsOf(md.ParameterList.Parameters);
                m.TypeParameters = md.TypeParameterList?.Parameters.Select(p => p.Identifier.ValueText).ToList() ?? new();
                iface = Iface(md.ExplicitInterfaceSpecifier);
                if (ext != null && !md.Modifiers.Any(SyntaxKind.StaticKeyword) && ext.Receiver.Length > 0)
                {
                    var arity = ext.Arity + (md.TypeParameterList?.Parameters.Count ?? 0);
                    m.Key = $"{path}.{m.Name}{(arity > 0 ? $"<{arity}>" : "")}({ExtParams(ext, m.Params)})";
                }
                else m.Key = $"{path}.{Pre(iface)}{m.Name}{Arity(md.TypeParameterList)}({KeyParams(m.Params)})";
                break;
            case ConstructorDeclarationSyntax cd:
                var isStatic = cd.Modifiers.Any(SyntaxKind.StaticKeyword);
                m.Kind = isStatic ? "static-constructor" : "constructor"; m.Name = cd.Identifier.ValueText; m.NameOffset = cd.Identifier.SpanStart;
                m.Params = ParamsOf(cd.ParameterList.Parameters);
                m.Key = isStatic ? $"{path}.<cinit>()" : $"{path}.<init>({KeyParams(m.Params)})";
                break;
            case OperatorDeclarationSyntax od:
                m.Kind = "operator"; m.Name = "operator " + (od.CheckedKeyword.IsKind(SyntaxKind.None) ? "" : "checked ") + od.OperatorToken.Text;
                m.NameOffset = od.OperatorKeyword.SpanStart; m.Returns = od.ReturnType.ToString(); m.Params = ParamsOf(od.ParameterList.Parameters);
                iface = Iface(od.ExplicitInterfaceSpecifier);
                m.Key = $"{path}.{Pre(iface)}{m.Name}({KeyParams(m.Params)})";
                break;
            case ConversionOperatorDeclarationSyntax co:
                m.Kind = "conversion"; m.Name = $"{co.ImplicitOrExplicitKeyword.Text} operator {Erase(co.Type)}";
                m.NameOffset = co.OperatorKeyword.SpanStart; m.Returns = co.Type.ToString(); m.Params = ParamsOf(co.ParameterList.Parameters);
                iface = Iface(co.ExplicitInterfaceSpecifier);
                m.Key = $"{path}.{Pre(iface)}{m.Name}({KeyParams(m.Params)})";
                break;
            case PropertyDeclarationSyntax pd:
                if (!Bodied(pd.ExpressionBody, pd.AccessorList) && !BodylessMember(pd)) return null;
                m.Kind = "property"; m.Name = pd.Identifier.ValueText; m.NameOffset = pd.Identifier.SpanStart; m.Returns = pd.Type.ToString();
                iface = Iface(pd.ExplicitInterfaceSpecifier);
                m.Key = ext != null && !pd.Modifiers.Any(SyntaxKind.StaticKeyword) && ext.Receiver.Length > 0
                    ? $"{path}.{m.Name}({ext.Receiver})" // an extension property: the receiver in brackets
                    : $"{path}.{Pre(iface)}{m.Name}";
                break;
            case IndexerDeclarationSyntax ix:
                if (!Bodied(ix.ExpressionBody, ix.AccessorList) && !BodylessMember(ix)) return null;
                m.Kind = "indexer"; m.Name = "this"; m.NameOffset = ix.ThisKeyword.SpanStart; m.Returns = ix.Type.ToString();
                m.Params = ParamsOf(ix.ParameterList.Parameters);
                iface = Iface(ix.ExplicitInterfaceSpecifier);
                m.Key = $"{path}.{Pre(iface)}this[{KeyParams(m.Params)}]";
                break;
            default:
                return null; // finalizers, events, fields: not symbols (C-D6)
        }
        m.ExplicitInterface = iface;
        var (headerEnd, body) = HeaderEnd(node);
        m.Body = body;
        var first = node.Modifiers.Count > 0 ? node.Modifiers.First() : FirstAfterAttributes(node);
        m.Header = Normalise(first, headerEnd.GetPreviousToken());
        return m;
    }

    static bool Bodied(ArrowExpressionClauseSyntax? expr, AccessorListSyntax? accessors) =>
        expr != null || (accessors != null && accessors.Accessors.Any(a => a.Body != null || a.ExpressionBody != null));

    /// A body-less property or indexer is a member (C-D4) when an interface declares it or it is
    /// `abstract`; a class's, struct's or record's auto-property is a field in practice.
    static bool BodylessMember(MemberDeclarationSyntax n) =>
        n.Parent is InterfaceDeclarationSyntax || n.Modifiers.Any(SyntaxKind.AbstractKeyword);

    static string Pre(string? iface) => iface == null ? "" : iface + ".";

    static string? Iface(ExplicitInterfaceSpecifierSyntax? s) => s == null ? null : NameWithArity(s.Name);

    /// An explicit interface's name in a key: the last segment, with its arity (`IEnumerable<1>`).
    static string NameWithArity(NameSyntax n) => n switch
    {
        QualifiedNameSyntax q => NameWithArity(q.Right),
        AliasQualifiedNameSyntax a => NameWithArity(a.Name),
        GenericNameSyntax g => g.Identifier.ValueText + $"<{g.TypeArgumentList.Arguments.Count}>",
        SimpleNameSyntax s => s.Identifier.ValueText,
        _ => n.ToString(),
    };

    static SyntaxToken FirstAfterAttributes(MemberDeclarationSyntax node)
    {
        var t = node.GetFirstToken();
        if (node.AttributeLists.Count > 0) t = node.AttributeLists.Last().GetLastToken().GetNextToken();
        return t;
    }

    /// The first token after the header: the body's `{`, `=>`, the accessor list's `{` or `;`.
    static (SyntaxToken end, string body) HeaderEnd(MemberDeclarationSyntax node)
    {
        switch (node)
        {
            case BaseMethodDeclarationSyntax b:
                if (b.Body != null) return (b.Body.OpenBraceToken, "block");
                if (b.ExpressionBody != null) return (b.ExpressionBody.ArrowToken, "expression");
                return (b.SemicolonToken, "none");
            case PropertyDeclarationSyntax p:
                if (p.ExpressionBody != null) return (p.ExpressionBody.ArrowToken, "expression");
                return (p.AccessorList!.OpenBraceToken, p.AccessorList.Accessors.Any(a => a.Body != null || a.ExpressionBody != null) ? "accessors" : "none");
            case IndexerDeclarationSyntax x:
                if (x.ExpressionBody != null) return (x.ExpressionBody.ArrowToken, "expression");
                return (x.AccessorList!.OpenBraceToken, x.AccessorList.Accessors.Any(a => a.Body != null || a.ExpressionBody != null) ? "accessors" : "none");
        }
        return (node.GetLastToken(), "none");
    }

    /// Tokens from `first` to `last` joined by one space wherever the source had trivia
    /// (comments dropped, whitespace collapsed).
    static string Normalise(SyntaxToken first, SyntaxToken last)
    {
        var sb = new StringBuilder();
        var t = first;
        while (true)
        {
            if (sb.Length > 0 && (t.HasLeadingTrivia || t.GetPreviousToken().HasTrailingTrivia)) sb.Append(' ');
            sb.Append(t.Text);
            if (t == last || t.IsKind(SyntaxKind.None) || t.SpanStart >= last.SpanStart) break;
            t = t.GetNextToken();
        }
        return sb.ToString();
    }

    static List<Param> ParamsOf(SeparatedSyntaxList<ParameterSyntax> ps) => ps.Select(p => new Param
    {
        Name = p.Identifier.ValueText,
        Type = p.Type?.ToString() ?? "",
        Modifiers = p.Modifiers.Select(x => x.Text).ToList(),
        Default = p.Default?.Value.ToString(),
        Attributes = p.AttributeLists.Select(a => a.ToString()).ToList(),
        KeyType = KeyType(p),
    }).ToList();

    /// C-D6: ref/out/in/params/this (and `ref readonly`) kept, `scoped` dropped, then the erased type.
    /// `this` comes first however it was written (`ref this Span<int> s` → `this ref Span`), so a
    /// classic extension method keys as its extension-block form does.
    static string KeyType(ParameterSyntax p)
    {
        var mods = p.Modifiers.Where(x => !x.IsKind(SyntaxKind.ScopedKeyword))
            .OrderBy(x => x.IsKind(SyntaxKind.ThisKeyword) ? 0 : 1).Select(x => x.Text);
        var type = p.Type == null ? "" : Erase(p.Type);
        return string.Join(" ", mods.Append(type));
    }

    static string KeyParams(List<Param> ps) => string.Join(", ", ps.Select(p => p.KeyType));

    static string ExtParams(Ext ext, List<Param> ps) => string.Join(", ", ps.Select(p => p.KeyType).Prepend(ext.Receiver));

    /// C-D6: types as written minus namespaces, generic arguments erased, `?`, arrays and
    /// pointers kept; a tuple's element names dropped.
    static string Erase(TypeSyntax t) => t switch
    {
        QualifiedNameSyntax q => Erase(q.Right),
        AliasQualifiedNameSyntax a => Erase(a.Name),
        GenericNameSyntax g => g.Identifier.ValueText,
        IdentifierNameSyntax i => i.Identifier.ValueText,
        PredefinedTypeSyntax p => p.Keyword.Text,
        ArrayTypeSyntax a => Erase(a.ElementType) + string.Concat(a.RankSpecifiers.Select(r => "[" + new string(',', r.Rank - 1) + "]")),
        NullableTypeSyntax n => Erase(n.ElementType) + "?",
        PointerTypeSyntax p => Erase(p.ElementType) + "*",
        TupleTypeSyntax tt => "(" + string.Join(", ", tt.Elements.Select(e => Erase(e.Type))) + ")",
        RefTypeSyntax r => "ref " + (r.ReadOnlyKeyword.IsKind(SyntaxKind.None) ? "" : "readonly ") + Erase(r.Type),
        ScopedTypeSyntax s => Erase(s.Type),
        _ => System.Text.RegularExpressions.Regex.Replace(t.ToString(), @"\s+", " "),
    };

    /// Repeats of one key in a file: `#2`, `#3` in source order (as Java's keys).
    static void Number(List<Member> members)
    {
        var seen = new Dictionary<string, int>();
        foreach (var m in members.OrderBy(m => m.Start))
        {
            var n = seen.GetValueOrDefault(m.Key) + 1;
            seen[m.Key] = n;
            if (n > 1) m.Key += "#" + n;
        }
    }

    // ---- output -------------------------------------------------------------------------

    static void Write(Utf8JsonWriter w, Member m, SyntaxTree tree)
    {
        var lines = tree.GetLineSpan(new Microsoft.CodeAnalysis.Text.TextSpan(m.Start, m.End - m.Start));
        w.WriteStartObject();
        w.WriteString("kind", m.Kind);
        w.WriteString("key", m.Key);
        w.WriteString("name", m.Name);
        w.WriteString("container", m.Container);
        if (m.ExplicitInterface != null) w.WriteString("explicitInterface", m.ExplicitInterface);
        w.WriteNumber("nameOffset", m.NameOffset);
        w.WriteNumber("start", m.Start);
        w.WriteNumber("end", m.End);
        w.WriteNumber("startLine", lines.StartLinePosition.Line + 1);
        w.WriteNumber("endLine", lines.EndLinePosition.Line + 1);
        Strings(w, "modifiers", m.Modifiers);
        Strings(w, "attributes", m.Attributes);
        Strings(w, "typeParameters", m.TypeParameters);
        if (m.Returns != null) w.WriteString("returns", m.Returns); else w.WriteNull("returns");
        w.WriteStartArray("params");
        foreach (var p in m.Params)
        {
            w.WriteStartObject();
            w.WriteString("name", p.Name);
            w.WriteString("type", p.Type);
            w.WriteString("keyType", p.KeyType);
            Strings(w, "modifiers", p.Modifiers);
            if (p.Default != null) w.WriteString("default", p.Default); else w.WriteNull("default");
            Strings(w, "attributes", p.Attributes);
            w.WriteEndObject();
        }
        w.WriteEndArray();
        if (m.Header != null) w.WriteString("header", m.Header); else w.WriteNull("header");
        if (m.Body != null) w.WriteString("body", m.Body);
        w.WriteEndObject();
    }

    static void Strings(Utf8JsonWriter w, string name, List<string> xs)
    {
        w.WriteStartArray(name);
        foreach (var x in xs) w.WriteStringValue(x);
        w.WriteEndArray();
    }

    // ---- git ----------------------------------------------------------------------------

    static string Git(string repo, params string[] args)
    {
        var psi = new ProcessStartInfo("git") { RedirectStandardOutput = true, UseShellExecute = false };
        psi.ArgumentList.Add("-C"); psi.ArgumentList.Add(repo);
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        var s = p.StandardOutput.ReadToEnd();
        p.WaitForExit();
        if (p.ExitCode != 0) throw new Exception($"git {string.Join(' ', args)} failed");
        return s;
    }

    /// `.cs` blobs at the commit, outside any `bin/` or `obj/` directory, sorted by path.
    static List<(string path, string blob)> ListCs(string repo, string sha)
    {
        var outp = Git(repo, "ls-tree", "-r", "-z", "--full-tree", sha);
        var list = new List<(string, string)>();
        foreach (var entry in outp.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            var tab = entry.IndexOf('\t');
            var meta = entry[..tab].Split(' ');
            var path = entry[(tab + 1)..];
            if (meta[1] != "blob" || !path.EndsWith(".cs", StringComparison.Ordinal)) continue;
            if (path.Split('/').SkipLast(1).Any(seg => seg == "bin" || seg == "obj")) continue;
            list.Add((path, meta[2]));
        }
        return list.OrderBy(x => x.Item1, StringComparer.Ordinal).ToList();
    }

    /// Blob texts via one `git cat-file --batch`, decoded as UTF-8 (a BOM stays as U+FEFF, as
    /// Node's Buffer#toString keeps it, so offsets agree with JavaScript strings).
    static List<string> ReadBlobs(string repo, List<string> blobs)
    {
        var psi = new ProcessStartInfo("git") { RedirectStandardOutput = true, RedirectStandardInput = true, UseShellExecute = false };
        foreach (var a in new[] { "-C", repo, "cat-file", "--batch" }) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        var writer = Task.Run(() =>
        {
            foreach (var b in blobs) p.StandardInput.Write(b + "\n");
            p.StandardInput.Close();
        });
        var input = p.StandardOutput.BaseStream;
        var texts = new List<string>();
        var utf8 = new UTF8Encoding(false, false);
        foreach (var _ in blobs)
        {
            var header = ReadLine(input); // "<sha> blob <size>"
            var size = int.Parse(header.Split(' ')[2]);
            var buf = new byte[size];
            int read = 0;
            while (read < size) { var n = input.Read(buf, read, size - read); if (n <= 0) throw new Exception("short read"); read += n; }
            input.ReadByte(); // the newline after the content
            texts.Add(utf8.GetString(buf));
        }
        writer.Wait();
        p.WaitForExit();
        return texts;
    }

    static string ReadLine(Stream s)
    {
        var sb = new StringBuilder();
        int c;
        while ((c = s.ReadByte()) >= 0 && c != '\n') sb.Append((char)c);
        return sb.ToString();
    }
}
