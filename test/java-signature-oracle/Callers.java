// Dev tool for test/lsp-harness/java-verify.js --syntactic --callers (J8, oracle (b)): attributes
// every .java file under a directory with javac (`JavacTask.analyze()`, com.sun.source.util,
// part of the JDK) and prints, as one JSON object per line, every method invocation and `new`
// with the declaration javac resolved it to (the exact overload), when that declaration is in
// one of the files. Nothing is run: annotation processing is off (`-proc:none`, so no
// processor from any classpath runs), no class file is written (analyze stops before
// generate), and the sources are only parsed and attributed.
// Usage: java Callers.java <srcDir> <classpath>
// Records:
//   {"call":…,"kind":"call"|"new","name":…,"target":{file,pos},"caller":{file,pos},"dispatch":bool}
//     positions are UTF-16 offsets into the file's text: a call's method name (`a.b.m(` at `m`),
//     a `new`'s type name (`new a.T<>(` at `T`), `this(`/`super(` at the keyword; a target's
//     declared name (a constructor's at its name); a caller is the outermost method or
//     constructor around the call (a lambda, an anonymous or local class are its body), else the
//     innermost named class. `dispatch`: the target is abstract, an interface member, or
//     overridden by a method in the files (a call may run another implementation).
//   {"unattributed":{file,pos,name}}: javac could not resolve it (missing classpath, errors).
//   {"excluded":{file,pos,why}}: `new T(…) { … }` (an anonymous class's constructor).
//   {"errors":n,"files":n}
import com.sun.source.tree.*;
import com.sun.source.util.*;
import javax.lang.model.element.*;
import javax.lang.model.type.*;
import javax.lang.model.util.*;
import javax.tools.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.*;

public class Callers {
  static String q(String s) {
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      if (c == '"' || c == '\\') b.append('\\').append(c);
      else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
      else b.append(c);
    }
    return b.append('"').toString();
  }

  public static void main(String[] args) throws Exception {
    Path root = Paths.get(args[0]).toAbsolutePath();
    String cp = args.length > 1 ? args[1] : "";
    List<File> files;
    try (Stream<Path> s = Files.walk(root)) {
      files = s.filter(p -> p.toString().endsWith(".java") && !p.getFileName().toString().equals("module-info.java"))
          .map(Path::toFile).sorted().collect(Collectors.toList());
    }
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
    StandardJavaFileManager fm = compiler.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
    List<String> options = new ArrayList<>(List.of("-proc:none", "-implicit:none", "-nowarn", "-Xmaxerrs", "1000000",
        "-XDshould-stop.ifError=FLOW", "-encoding", "UTF-8"));
    if (!cp.isEmpty()) { options.add("-cp"); options.add(cp); }
    JavacTask task = (JavacTask) compiler.getTask(null, fm, diags, options, null, fm.getJavaFileObjectsFromFiles(files));
    Iterable<? extends CompilationUnitTree> units = task.parse();
    task.analyze();
    Trees trees = Trees.instance(task);
    Elements elements = task.getElements();
    Types types = task.getTypes();
    SourcePositions sp = trees.getSourcePositions();
    PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
    Map<CompilationUnitTree, String> texts = new HashMap<>();
    for (CompilationUnitTree cu : units) texts.put(cu, cu.getSourceFile().getCharContent(true).toString());

    // The methods overridden by a method in the files.
    Set<Element> overridden = new HashSet<>();
    for (CompilationUnitTree cu : units) {
      new TreePathScanner<Void, Void>() {
        @Override public Void visitMethod(MethodTree m, Void v) {
          Element e = trees.getElement(getCurrentPath());
          if (e instanceof ExecutableElement && e.getKind() == ElementKind.METHOD && e.getEnclosingElement() instanceof TypeElement) {
            TypeElement owner = (TypeElement) e.getEnclosingElement();
            Deque<TypeMirror> work = new ArrayDeque<>(types.directSupertypes(owner.asType()));
            Set<String> seen = new HashSet<>();
            while (!work.isEmpty()) {
              TypeMirror t = work.pop();
              Element te = types.asElement(t);
              if (!(te instanceof TypeElement) || !seen.add(((TypeElement) te).getQualifiedName().toString())) continue;
              for (Element m2 : te.getEnclosedElements()) {
                if (m2.getKind() == ElementKind.METHOD && m2.getSimpleName().equals(e.getSimpleName())
                    && elements.overrides((ExecutableElement) e, (ExecutableElement) m2, owner)) overridden.add(m2);
              }
              work.addAll(types.directSupertypes(t));
            }
          }
          return super.visitMethod(m, v);
        }
      }.scan(cu, null);
    }

    int[] errors = { 0 };
    for (Diagnostic<? extends JavaFileObject> d : diags.getDiagnostics()) if (d.getKind() == Diagnostic.Kind.ERROR) errors[0]++;

    for (CompilationUnitTree cu : units) {
      String file = root.relativize(Paths.get(cu.getSourceFile().toUri())).toString().replace('\\', '/');
      new TreePathScanner<Void, Void>() {
        String rel(CompilationUnitTree u) { return root.relativize(Paths.get(u.getSourceFile().toUri())).toString().replace('\\', '/'); }

        long namePos(CompilationUnitTree u, Tree t) {
          if (t instanceof ParameterizedTypeTree) t = ((ParameterizedTypeTree) t).getType();
          if (t instanceof AnnotatedTypeTree) t = ((AnnotatedTypeTree) t).getUnderlyingType();
          if (t instanceof MemberSelectTree) return sp.getEndPosition(u, t) - ((MemberSelectTree) t).getIdentifier().length();
          return sp.getStartPosition(u, t);
        }

        long declPos(CompilationUnitTree u, MethodTree m, String name) {
          String text = texts.get(u);
          long from = sp.getStartPosition(u, m);
          long mods = sp.getEndPosition(u, m.getModifiers());
          if (mods > from) from = mods;
          if (m.getReturnType() != null) { long r = sp.getEndPosition(u, m.getReturnType()); if (r > from) from = r; }
          java.util.regex.Matcher mt = java.util.regex.Pattern.compile("\\b" + java.util.regex.Pattern.quote(name) + "\\s*[({]").matcher(text);
          return mt.find((int) from) ? mt.start() : from;
        }

        String where(Element target) {
          TreePath p = trees.getPath(target);
          if (p == null || !(p.getLeaf() instanceof MethodTree)) return null;
          MethodTree m = (MethodTree) p.getLeaf();
          String name = target.getKind() == ElementKind.CONSTRUCTOR ? target.getEnclosingElement().getSimpleName().toString() : m.getName().toString();
          return "{\"file\":" + q(rel(p.getCompilationUnit())) + ",\"pos\":" + declPos(p.getCompilationUnit(), m, name) + "}";
        }

        String caller() {
          List<Tree> path = new ArrayList<>();
          for (TreePath p = getCurrentPath(); p != null; p = p.getParentPath()) path.add(0, p.getLeaf());
          for (Tree t : path) {
            if (t instanceof MethodTree) {
              MethodTree m = (MethodTree) t;
              Element e = trees.getElement(trees.getPath(cu, m));
              String name = e != null && e.getKind() == ElementKind.CONSTRUCTOR ? e.getEnclosingElement().getSimpleName().toString() : m.getName().toString();
              return "{\"file\":" + q(file) + ",\"pos\":" + declPos(cu, m, name) + "}";
            }
          }
          for (int i = path.size() - 1; i >= 0; i--) {
            if (path.get(i) instanceof ClassTree && !((ClassTree) path.get(i)).getSimpleName().toString().isEmpty()) {
              ClassTree c = (ClassTree) path.get(i);
              String text = texts.get(cu);
              java.util.regex.Matcher mt = java.util.regex.Pattern.compile("\\b(class|interface|enum|record)\\s+" + java.util.regex.Pattern.quote(c.getSimpleName().toString()) + "\\b").matcher(text);
              long pos = mt.find((int) sp.getStartPosition(cu, c)) ? mt.end() - c.getSimpleName().length() : sp.getStartPosition(cu, c);
              return "{\"file\":" + q(file) + ",\"pos\":" + pos + "}";
            }
          }
          return "null";
        }

        void emit(Tree site, long pos, String kind, String name) {
          Element e = trees.getElement(getCurrentPath());
          if (e == null || e.asType() == null || e.asType().getKind() == TypeKind.ERROR || !(e instanceof ExecutableElement)) {
            out.println("{\"unattributed\":{\"file\":" + q(file) + ",\"pos\":" + pos + ",\"name\":" + q(name) + "}}");
            return;
          }
          String w = where(e);
          if (w == null) return; // a declaration outside the files
          boolean dispatch = overridden.contains(e) || e.getModifiers().contains(Modifier.ABSTRACT)
              || (e.getEnclosingElement() != null && e.getEnclosingElement().getKind() == ElementKind.INTERFACE);
          out.println("{\"call\":{\"file\":" + q(file) + ",\"pos\":" + pos + "},\"kind\":" + q(kind) + ",\"name\":" + q(name)
              + ",\"target\":" + w + ",\"caller\":" + caller() + ",\"dispatch\":" + dispatch + "}");
        }

        @Override public Void visitMethodInvocation(MethodInvocationTree t, Void v) {
          ExpressionTree sel = t.getMethodSelect();
          String name = sel instanceof MemberSelectTree ? ((MemberSelectTree) sel).getIdentifier().toString() : sel.toString();
          long pos = sel instanceof MemberSelectTree ? sp.getEndPosition(cu, sel) - name.length() : sp.getStartPosition(cu, sel);
          boolean ctor = name.equals("this") || name.equals("super");
          emit(t, pos, ctor ? "new" : "call", name);
          return super.visitMethodInvocation(t, v);
        }

        @Override public Void visitNewClass(NewClassTree t, Void v) {
          long pos = namePos(cu, t.getIdentifier());
          if (t.getClassBody() != null) out.println("{\"excluded\":{\"file\":" + q(file) + ",\"pos\":" + pos + ",\"why\":\"anonymous class\"}}");
          else emit(t, pos, "new", t.getIdentifier().toString());
          return super.visitNewClass(t, v);
        }
      }.scan(cu, null);
    }
    out.println("{\"errors\":" + errors[0] + ",\"files\":" + files.size() + "}");
  }
}
