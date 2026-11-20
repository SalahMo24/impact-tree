// Outline fixture (C3): top-level statements, a local function among them, a type after them.
using System;

// start
var app = Build(args);
using var scope = app.Scope();
static int Build(string[] a) { return 1; }
app.Run();

public partial class Program { public static void Helper() { } }
