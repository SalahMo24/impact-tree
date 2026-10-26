// Dev tool for test/lsp-harness/java-verify.js (J7, oracle (a)): parses every .java file
// under a directory with the JDK's own parser (javax.tools + com.sun.source.tree) and
// prints, for every method and constructor that is a changed-symbol candidate, one JSON
// line: where it is (lines), how it is keyed and the facts of its header. Parse only:
// nothing is compiled, attributed or run. Shares no code with src/.
// Usage: java Members.java <dir>
//
// Candidates and paths (J2's keying, written again here from the Tree API):
// - methods and constructors of every class, interface, enum, record and annotation type,
//   nested types included (path: the enclosing type names, outermost first);
// - methods of an anonymous class in a field's initializer or an enum constant's body
//   (path: the enclosing types, then the field or constant name), at any depth of that
//   initializer (lambdas included) except inside another anonymous body's methods;
// - nothing inside a method, constructor or initializer block (local and anonymous classes
//   there are that member's body).
// Parameter key types are erased from the tree, not from text: type arguments dropped, the
// last segment of a qualified name, annotations dropped, `[]` kept, varargs `...`.
// A record's compact constructor is given the record components' types, as jdtls names it.
import com.sun.source.tree.*;
import com.sun.source.util.*;
import javax.lang.model.element.Modifier;
import javax.tools.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.*;

public class Members {
  static String q(String s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      switch (c) {
        case '"': b.append("\\\""); break;
        case '\\': b.append("\\\\"); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default: if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
      }
    }
    return b.append('"').toString();
  }

  static String arr(Collection<String> xs) {
    return xs.stream().map(Members::q).collect(Collectors.joining(",", "[", "]"));
  }

  /** The key form of a type, from the tree. */
  static String erased(Tree t) {
    if (t == null) return "";
    switch (t.getKind()) {
      case PARAMETERIZED_TYPE: return erased(((ParameterizedTypeTree) t).getType());
      case MEMBER_SELECT: return ((MemberSelectTree) t).getIdentifier().toString();
      case IDENTIFIER: return ((IdentifierTree) t).getName().toString();
      case ARRAY_TYPE: return erased(((ArrayTypeTree) t).getType()) + "[]";
      case ANNOTATED_TYPE: return erased(((AnnotatedTypeTree) t).getUnderlyingType());
      default: return t.toString();
    }
  }

  /** A type as written, annotations dropped (as J3's oracle compares types). */
  static String written(Tree t) {
    return t == null ? null : t.toString().replaceAll("@[\\w.]+(\\((?:[^()]|\\([^()]*\\))*\\))?\\s*", "").trim();
  }

  public static void main(String[] args) throws Exception {
    Path root = Paths.get(args[0]);
    List<Path> files;
    try (Stream<Path> s = Files.walk(root)) {
      files = s.filter(p -> p.toString().endsWith(".java") && Files.isRegularFile(p)).sorted().collect(Collectors.toList());
    }
    JavaCompiler jc = ToolProvider.getSystemJavaCompiler();
    PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), false, StandardCharsets.UTF_8);
    for (Path f : files) {
      String rel = root.relativize(f).toString().replace(File.separatorChar, '/');
      final String text = Files.readString(f, StandardCharsets.UTF_8);
      JavaFileObject fo = new SimpleJavaFileObject(f.toUri(), JavaFileObject.Kind.SOURCE) {
        @Override public CharSequence getCharContent(boolean ignore) { return text; }
      };
      DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
      JavacTask task = (JavacTask) jc.getTask(null, null, diags, List.of("-proc:none", "--release", "21"), null, List.of(fo));
      Iterable<? extends CompilationUnitTree> units;
      try { units = task.parse(); } catch (Exception e) { out.println("{\"skipped\":" + q(rel) + "}"); continue; }
      if (diags.getDiagnostics().stream().anyMatch(d -> d.getKind() == Diagnostic.Kind.ERROR)) {
        out.println("{\"skipped\":" + q(rel) + "}");
        continue;
      }
      SourcePositions pos = Trees.instance(task).getSourcePositions();
      for (CompilationUnitTree cu : units) {
        LineMap lines = cu.getLineMap();
        new Object() {
          void walkType(ClassTree c, List<String> path) {
            boolean iface = c.getKind() == Tree.Kind.INTERFACE || c.getKind() == Tree.Kind.ANNOTATION_TYPE;
            for (Tree m : c.getMembers()) {
              if (m instanceof MethodTree mt) emit(c, mt, path, iface);
              else if (m instanceof ClassTree ct) walkType(ct, plus(path, ct.getSimpleName().toString()));
              else if (m instanceof VariableTree vt && vt.getInitializer() != null) anonymousIn(vt.getInitializer(), plus(path, vt.getName().toString()));
            }
          }

          void anonymousIn(Tree init, List<String> path) {
            new TreeScanner<Void, Void>() {
              @Override public Void visitNewClass(NewClassTree n, Void v) {
                scan(n.getEnclosingExpression(), v);
                scan(n.getArguments(), v);
                if (n.getClassBody() != null) walkType(n.getClassBody(), path);
                return null;
              }
            }.scan(init, null);
          }

          List<String> plus(List<String> p, String s) { List<String> r = new ArrayList<>(p); r.add(s); return r; }

          void emit(ClassTree owner, MethodTree m, List<String> path, boolean inInterface) {
            long start = pos.getStartPosition(cu, m);
            long end = pos.getEndPosition(cu, m);
            if (start < 0 || end <= start) return;
            boolean ctor = m.getName().contentEquals("<init>");
            List<String> mods = new ArrayList<>();
            for (Modifier x : m.getModifiers().getFlags()) mods.add(x.toString());
            List<String> annos = new ArrayList<>();
            for (AnnotationTree a : m.getModifiers().getAnnotations()) annos.add(a.getAnnotationType().toString());
            String tps = m.getTypeParameters().isEmpty() ? ""
              : m.getTypeParameters().stream().map(Object::toString).collect(Collectors.joining(", ", "<", ">"));
            List<String> keyTypes = new ArrayList<>();
            StringBuilder ps = new StringBuilder("[");
            boolean compact = false;
            List<? extends VariableTree> params = m.getParameters();
            if (ctor && owner.getKind() == Tree.Kind.RECORD) {
              long bodyStart = m.getBody() == null ? end : pos.getStartPosition(cu, m.getBody());
              String head = text.substring((int) start, (int) bodyStart).replaceAll("@[\\w.]+(\\((?:[^()]|\\([^()]*\\))*\\))?", "");
              if (!head.contains("(")) {
                compact = true;
                List<VariableTree> comps = new ArrayList<>();
                for (Tree x : owner.getMembers()) {
                  if (x instanceof VariableTree vt && !vt.getModifiers().getFlags().contains(Modifier.STATIC)) comps.add(vt);
                }
                params = comps;
              }
            }
            boolean first = true;
            for (VariableTree p : params) {
              long p0 = pos.getStartPosition(cu, p), p1 = pos.getEndPosition(cu, p);
              String ptext = p0 >= 0 && p1 > p0 ? text.substring((int) p0, (int) p1) : "";
              boolean varargs = ptext.replaceAll("@[\\w.]+(\\((?:[^()]|\\([^()]*\\))*\\))?", "").contains("...");
              String key = erased(p.getType());
              if (varargs && key.endsWith("[]")) key = key.substring(0, key.length() - 2) + "...";
              keyTypes.add(key);
              String type = written(p.getType());
              if (varargs && type.endsWith("[]")) type = type.substring(0, type.length() - 2) + "...";
              if (!first) ps.append(',');
              first = false;
              ps.append("{\"name\":").append(q(p.getName().toString()))
                .append(",\"type\":").append(q(type)).append(",\"rest\":").append(varargs).append('}');
            }
            ps.append(']');
            List<String> throwsList = m.getThrows().stream().map(Members::written).collect(Collectors.toList());
            TreeSet<String> thrown = new TreeSet<>();
            if (m.getBody() != null) {
              new TreeScanner<Void, Void>() {
                @Override public Void visitLambdaExpression(LambdaExpressionTree t, Void v) { return null; }
                @Override public Void visitClass(ClassTree t, Void v) { return null; }
                @Override public Void visitThrow(ThrowTree t, Void v) {
                  if (t.getExpression() instanceof NewClassTree nc) {
                    Tree id = nc.getIdentifier();
                    if (id instanceof ParameterizedTypeTree pt) id = pt.getType();
                    thrown.add(id.toString());
                  }
                  return super.visitThrow(t, v);
                }
              }.scan(m.getBody(), null);
            }
            out.println("{\"file\":" + q(rel) + ",\"path\":" + arr(path) + ",\"name\":" + q(ctor ? "<init>" : m.getName().toString())
              + ",\"constructor\":" + ctor + ",\"compact\":" + compact + ",\"keyTypes\":" + arr(keyTypes)
              + ",\"startLine\":" + lines.getLineNumber(start) + ",\"endLine\":" + lines.getLineNumber(end - 1)
              + ",\"inInterface\":" + inInterface + ",\"modifiers\":" + arr(mods) + ",\"annotations\":" + arr(annos)
              + ",\"typeParameters\":" + q(tps) + ",\"returns\":" + q(ctor ? null : written(m.getReturnType())) + ",\"params\":" + ps
              + ",\"throws\":" + arr(throwsList) + ",\"thrown\":" + arr(thrown) + "}");
          }

          void run() {
            for (Tree t : cu.getTypeDecls()) {
              if (t instanceof ClassTree ct) walkType(ct, List.of(ct.getSimpleName().toString()));
            }
          }
        }.run();
      }
    }
    out.flush();
  }
}
