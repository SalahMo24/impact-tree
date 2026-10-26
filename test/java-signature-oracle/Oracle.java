// Dev tool for test/java-signature-oracle.js (J3): parses every .java file under a directory
// with the JDK's own parser (javax.tools + com.sun.source.tree, part of the JDK) and prints,
// for every method and constructor, the facts src/languages/java/signature.js must agree on,
// as one JSON object per line. Parse only: nothing is compiled, attributed or run.
// Usage: java Oracle.java <dir> [max-files]
import com.sun.source.tree.*;
import com.sun.source.util.*;
import javax.lang.model.element.Modifier;
import javax.tools.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.*;

public class Oracle {
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
    return xs.stream().map(Oracle::q).collect(Collectors.joining(",", "[", "]"));
  }

  public static void main(String[] args) throws Exception {
    Path root = Paths.get(args[0]);
    List<Path> files;
    try (Stream<Path> s = Files.walk(root)) {
      files = s.filter(p -> p.toString().endsWith(".java") && !p.toString().contains("/.git/")).sorted().collect(Collectors.toList());
    }
    int limit = args.length > 1 ? Integer.parseInt(args[1]) : Integer.MAX_VALUE;
    JavaCompiler jc = ToolProvider.getSystemJavaCompiler();
    PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), false, StandardCharsets.UTF_8);
    int n = 0;
    for (Path f : files) {
      if (n++ >= limit) break;
      String rel = root.relativize(f).toString();
      String src;
      try { src = Files.readString(f, StandardCharsets.UTF_8); } catch (Exception e) { out.println("{\"skipped\":" + q(rel) + "}"); continue; }
      final String text = src;
      JavaFileObject fo = new SimpleJavaFileObject(f.toUri(), JavaFileObject.Kind.SOURCE) {
        @Override public CharSequence getCharContent(boolean ignore) { return text; }
      };
      DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
      JavacTask task = (JavacTask) jc.getTask(null, null, diags, List.of("-proc:none"), null, List.of(fo));
      Iterable<? extends CompilationUnitTree> units;
      try { units = task.parse(); } catch (Exception e) { out.println("{\"skipped\":" + q(rel) + "}"); continue; }
      if (diags.getDiagnostics().stream().anyMatch(d -> d.getKind() == Diagnostic.Kind.ERROR)) {
        out.println("{\"skipped\":" + q(rel) + "}");
        continue;
      }
      SourcePositions pos = Trees.instance(task).getSourcePositions();
      for (CompilationUnitTree cu : units) {
        new TreePathScanner<Void, Void>() {
          @Override public Void visitMethod(MethodTree m, Void v) {
            long start = pos.getStartPosition(cu, m);
            long end = pos.getEndPosition(cu, m);
            if (start >= 0 && end > start) emit(m, start, end);
            return super.visitMethod(m, v);
          }

          void emit(MethodTree m, long start, long end) {
            long headerEnd = m.getBody() != null ? pos.getStartPosition(cu, m.getBody()) : end - 1;
            List<String> mods = new ArrayList<>();
            for (Modifier x : m.getModifiers().getFlags()) mods.add(x.toString());
            List<String> annos = new ArrayList<>();
            for (AnnotationTree a : m.getModifiers().getAnnotations()) annos.add(a.getAnnotationType().toString());
            String tps = m.getTypeParameters().isEmpty() ? ""
              : m.getTypeParameters().stream().map(Object::toString).collect(Collectors.joining(", ", "<", ">"));
            StringBuilder ps = new StringBuilder("[");
            boolean first = true;
            for (VariableTree p : m.getParameters()) {
              long p0 = pos.getStartPosition(cu, p), p1 = pos.getEndPosition(cu, p);
              String ptext = p0 >= 0 && p1 > p0 ? text.substring((int) p0, (int) p1) : "";
              boolean varargs = ptext.replaceAll("@[\\w.]+(\\([^)]*\\))?", "").contains("...");
              if (!first) ps.append(',');
              first = false;
              ps.append("{\"name\":").append(q(p.getName().toString()))
                .append(",\"type\":").append(q(p.getType() == null ? null : p.getType().toString()))
                .append(",\"varargs\":").append(varargs).append('}');
            }
            ps.append(']');
            List<String> throwsList = m.getThrows().stream().map(Object::toString).collect(Collectors.toList());
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
            String ret = m.getReturnType() == null ? null : m.getReturnType().toString();
            out.println("{\"file\":" + q(rel) + ",\"start\":" + start + ",\"end\":" + end + ",\"headerEnd\":" + headerEnd
              + ",\"name\":" + q(m.getName().toString()) + ",\"modifiers\":" + arr(mods) + ",\"annotations\":" + arr(annos)
              + ",\"typeParameters\":" + q(tps) + ",\"returns\":" + q(ret) + ",\"params\":" + ps
              + ",\"throws\":" + arr(throwsList) + ",\"thrown\":" + arr(thrown) + "}");
          }
        }.scan(cu, null);
      }
    }
    out.flush();
  }
}
