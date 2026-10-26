'use strict';
// Java texts whose document symbols jdtls gave are recorded in ./recorded.json by
// test/lsp-harness/record-java-symbols.js; test/java-symbols.test.js replays them, so it
// needs no editor and no jdtls. Three are google/gson files at 57731049 (Apache-2.0,
// © Google Inc.), kept as `.java.txt` so nothing treats them as this repository's Java:
// `Gson.java` (overloads, generic methods, a nested class, constructors, anonymous classes
// in methods), `FieldNamingPolicy.java` (an enum with constant bodies) and
// `MapTypeAdapterFactory.java` (a generic inner class). The others are written for what gson
// lacks (records, interfaces with default and static methods, local classes, lambdas, an
// anonymous class in a field, overloads that change). Change a text only together with a
// new recording: the test checks each text's hash against the one recorded.

const fs = require('fs');
const path = require('path');

const gsonFile = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');

const shapes = `package demo;

import java.util.List;
import java.util.Map;

/** A record. */
public record Point(int x, int y) {
  /** Compact constructor. */
  public Point {
    if (x < 0) throw new IllegalArgumentException();
  }
  public Point(int both) { this(both, both); }
  static Point origin() { return new Point(0, 0); }
}

interface Shape {
  double area();
  /** A default method. */
  default String describe(String prefix, int... extra) { return prefix + area(); }
  static Shape unit() { return () -> 1.0; }
}

class Generic<T extends Comparable<T>> {
  static final Runnable TASK = new Runnable() {
    @Override public void run() { System.out.println("task"); }
  };
  <K, V> Map<K, List<V>> group(List<? extends V> items, java.util.function.Function<V, K> key, T[] arr, int[][] grid) { return null; }
  void inner() {
    Runnable r = () -> System.out.println("x");
    Object o = new Object() { @Override public String toString() { return "anon"; } };
    class Local { void m() {} }
  }
  // A line comment before the annotations.
  @Deprecated
  @SuppressWarnings({"unchecked", "rawtypes"})
  final synchronized void annotated(final @Deprecated String s) {}
  static class Nested<E> {
    Nested(Class<?>... types) {}
    protected List<E>[] lists(Map.Entry<String, E> entry) { return null; }
  }
}
`;

const overloadsBase = `package demo;

public class Codec {
  public String encode(String s) {
    return s;
  }

  public String encode(int n) {
    return Integer.toString(n);
  }

  public String decode(String s) {
    return s;
  }

  public void flush() {
  }

  public void reset(int a) {
  }

  public void reset(long a) {
  }
}
`;

// One `encode` overload changes its parameter (one out, one in: paired), `decode` gains a
// parameter (one out, one in: paired), the two `reset` overloads both change (two out, two
// in: not paired), and `flush` gains an overload (nothing out, one in: added).
const overloadsHead = `package demo;

public class Codec {
  public String encode(String s) {
    return s;
  }

  public String encode(long n) {
    return Long.toString(n);
  }

  public String decode(String s, boolean strict) {
    return s;
  }

  public void flush() {
  }

  public void flush(boolean force) {
  }

  public void reset(short a) {
  }

  public void reset(byte a) {
  }
}
`;

module.exports = {
  'Gson.java': gsonFile('gson_Gson.java.txt'),
  'FieldNamingPolicy.java': gsonFile('gson_FieldNamingPolicy.java.txt'),
  'MapTypeAdapterFactory.java': gsonFile('gson_MapTypeAdapterFactory.java.txt'),
  'Shapes.java': shapes,
  'Codec.java@base': overloadsBase,
  'Codec.java@head': overloadsHead,
};
