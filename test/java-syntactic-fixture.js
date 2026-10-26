'use strict';
// The Java sources test/java-syntactic.test.js indexes (J8): one call per rule and non-rule.

const LIB = `package com.ex.lib;
import java.util.List;
public class Client extends Base {
  private Inner inner = new Inner();
  public Client() {}
  public Client(int x) { this(); }
  public static Client create() { return new Client(); }
  public Inner getInner() { return inner; }
  public void send(String s) {}
  public void send(int n) {}
  public void send(String s, int n) {}
  public final void close() { helper(); }
  private void helper() {}
  static void util(String... xs) {}
}
`;
const BASE = `package com.ex.lib;
public class Base { public void ping() {} }
`;
const INNER = `package com.ex.lib;
public final class Inner { public void run() {} }
`;
const DOER = `package com.ex.lib;
public interface Doer { void doIt(); }
`;
const IMPL = `package com.ex.lib;
public class Impl implements Doer { public void doIt() {} }
`;
const POJO = `package com.ex.lib;
@lombok.Data
public class Pojo { private String name; public void touch() {} }
`;
const OTHER = `package com.ex.other;
public class Client { public void send(String s) {} public void close() {} }
`;
const APP = `package com.ex.app;
import com.ex.lib.Client;
import com.ex.lib.*;
import static com.ex.lib.Client.util;
import java.util.function.Consumer;
class App {
  Client field;
  void a(Client c) {
    c.send("x");
    c.send("x", 1);
    field.close();
    var v = new Client(3);
    v.getInner().run();
    ((Client) obj()).close();
    Client.create();
    util("a", "b");
    Consumer<String> f = c::send;
    list().forEach(x -> x.close());
    // c.close();
    String s = "c.close()";
    new Inner().run();
    Doer d = new Impl();
    d.doIt();
    new Impl().doIt();
    new Pojo().getName();
    new Pojo().touch();
    com.ex.other.Client o = null;
    o.close();
  }
  Object obj() { return null; }
  java.util.List<Client> list() { return null; }
}
class Sub extends Client {
  void b() { super.close(); ping(); close(); this.getInner(); }
}
`;

// Run 2's corrections (gson): a method declared in an anonymous class is no call, and its
// parameters are typed; enum constants call the constructor; explicit type arguments.
const MORE = `package com.ex.app;
import com.ex.lib.*;
import java.util.Collections;
enum Mode {
  FAST(1), SLOW(2, Collections.<String, Integer>emptyMap()), NONE;
  Mode(int n) {}
  Mode(int n, java.util.Map<String, Integer> m) {}
  Mode() {}
}
class Anon {
  Doer make(Client c) {
    return new Doer() {
      public void doIt() { helperOf(c); }
      void helperOf(Client k) { k.getInner(); }
    };
  }
  void typed(Client c) { c.<String>getInner(); }
}
`;

const SOURCES = [
  { path: 'app/More.java', text: MORE },
  { path: 'lib/Client.java', text: LIB }, { path: 'lib/Base.java', text: BASE }, { path: 'lib/Inner.java', text: INNER },
  { path: 'lib/Doer.java', text: DOER }, { path: 'lib/Impl.java', text: IMPL }, { path: 'lib/Pojo.java', text: POJO },
  { path: 'other/Client.java', text: OTHER }, { path: 'app/App.java', text: APP },
];

module.exports = { SOURCES, LIB, APP };
