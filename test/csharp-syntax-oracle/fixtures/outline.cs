// Outline fixture (C3): every construct of PLAN.md §2 plus C# 14 extension blocks, the `field`
// keyword, partial properties, tuples inside generics, Result and Result<T> in one file, and
// #if branches. Its members, keyed by the syntax oracle, are outline.expected.json
// (`csharp-verify.js --fixture-keys`); test/csharp-outline.test.js checks the outline against it.
global using System.Text;
using System;
using Alias = System.Collections.Generic.Dictionary<string, int>;

namespace Shop.Orders
{
    /// <summary>Doc comments are outside the range.</summary>
    [ApiController]
    [Route("api/[controller]")]
    public partial class OrdersController(IOrderService service, ILogger<OrdersController> log) : ControllerBase
    {
        private readonly int _count;
        public int Count { get; set; } = 3;
        public event EventHandler Changed;
        public event EventHandler Custom { add { } remove { } }
        public string Name { get => _name; set => _name = value; }
        public int Twice => _count * 2;
        public int this[int i] => i;
        ~OrdersController() { }

        [HttpGet("{id}")]
        public async Task<IActionResult> Get(int id, string? filter = null, params string[] tags) { return Ok(); }
        public void Get(ref int a, out string b, in Guid c) { b = ""; }
        public T Find<T>(Guid? id) where T : class, new() => default!;
        public void Local() { int Inner() => 1; Func<int, int> f = x => { return x; }; }
        public static Money operator +(Money a, Money b) => a;
        public static bool operator <=(Money a, Money b) => true;
        public static bool operator >=(Money a, Money b) => true;
        public static implicit operator Money(decimal d) => default;
        static OrdersController() { }
        public OrdersController() : this(null!, null!) { }
    }

    public partial class OrdersController
    {
        public void Get(string key) { }
    }

    public interface IOrderService
    {
        Task<Order?> GetAsync(int id, CancellationToken ct = default);
        string Name { get; }
        int this[string k] { get; }
        void Body() { }
    }

    public abstract class Base
    {
        public abstract int Size { get; }
        protected abstract void Run();
        public int Plain { get; init; }
    }

    public static class Extensions
    {
        public static bool IsEmpty(this string? s) => s is null;
        extension(Order o)
        {
            public decimal Total => o.Lines.Sum(l => l.Price);
            public bool Has(int id) => true;
        }
    }

    public record Point(int X, int Y);
    public record struct Size(int W, int H) { public int Area() => W * H; }
    public readonly ref struct Span2 { public int Length => 0; }
    public enum Color { Red, Green }
    public delegate void Handler(int x);
}

namespace Shop.Results;

public class Result { public static Result Ok() => new(); }
public class Result<T> { public static Result<T> Ok(T value) => new(); public Result<T> Map(Func<T, (int Id, List<(string, T?)> Rows)> f) => this; }
public class Nested<TKey, TValue> { public class Inner { public void M(Dictionary<TKey, (int, string)> d) { } } }
public partial class Person
{
    public partial string Name { get; set; }
    public partial string Name { get => field; set => field = value.Trim(); }
    public int Age { get => field; set => field = value < 0 ? 0 : value; }
}

class Conditional
{
#if DEBUG
    void OnlyDebug() { }
    string s = "unterminated
#elif RELEASE
    void OnlyRelease() { }
#else
    void Otherwise() { }
#endif
#if !NET8_0
    void NotNet8() { }
#endif
#if (true || X) && !Y
    void Expression() { }
#endif
}
