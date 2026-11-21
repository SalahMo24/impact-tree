// Key fixture for the syntax oracle (C-D6): constructs the test repositories lack. Its expected
// keys are keys.expected.json; `csharp-verify.js --fixture-keys` runs the oracle on this file
// and compares. Parsed only, never compiled.
using System;
using System.Collections;
using System.Collections.Generic;

namespace Fixture;

// C# 14 extension blocks: an instance member keys as the classic extension method.
public static class Classic
{
    public static int Len(this string s) => s.Length;
    public static int Len(this int i) => i;
    public static void Each<T, U>(this List<T> list, U state) { }
    public static void Bump(ref this Span<int> s) { }
}

public static class Blocks
{
    extension(string s)
    {
        public int Len() => s.Length;
        public int Count => s.Length;
        public static string Empty() => "";
    }
    extension(int i)
    {
        public int Len() => i;
    }
    extension<T>(List<T> list)
    {
        public void Each<U>(U state) { }
    }
    extension(ref Span<int> s)
    {
        public void Bump() { }
    }
    extension(Money)
    {
        public static Money Zero() => default;
        public static Money operator +(Money a, Money b) => a;
    }
}

public struct Money : IEquatable<Money>, IEnumerable<int>, IComparable<Money>
{
    // Operators, checked operators, conversions (checked and not).
    public static Money operator +(Money a, Money b) => a;
    public static Money operator checked +(Money a, Money b) => a;
    public static Money operator -(Money a) => a;
    public static bool operator ==(Money a, Money b) => true;
    public static bool operator !=(Money a, Money b) => false;
    public static implicit operator decimal(Money m) => 0m;
    public static explicit operator Money(decimal d) => default;
    public static explicit operator checked Money(long d) => default;
    public static explicit operator Money(long d) => default;

    // Indexers: plain, overloaded, explicit interface.
    public int this[int i] => i;
    public int this[string key, int? fallback = null] { get { return 0; } set { } }

    // Generic explicit implementations.
    bool IEquatable<Money>.Equals(Money other) => true;
    IEnumerator<int> IEnumerable<int>.GetEnumerator() { yield break; }
    IEnumerator IEnumerable.GetEnumerator() => null!;
    int IComparable<Money>.CompareTo(Money other) => 0;
    public override bool Equals(object? o) => false;
    public override int GetHashCode() => 0;
}

public interface IStore<T>
{
    T this[int id] { get; }
    T Get(int id);
    static abstract IStore<T> Create();
}

public sealed class Store : IStore<string>, IStore<int>
{
    string IStore<string>.this[int id] => "";
    int IStore<int>.this[int id] => 0;
    string IStore<string>.Get(int id) => "";
    int IStore<int>.Get(int id) => 0;
    static IStore<string> IStore<string>.Create() => new Store();
    static IStore<int> IStore<int>.Create() => new Store();
}
