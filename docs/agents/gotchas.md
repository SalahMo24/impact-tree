# Gotchas

Facts no config confesses, each found the slow way.

## Editor and driver

- Opening the Impact Tree view starts no analysis (`impactTree.analyseOnStartup` is off by default);
  a driver run must pick a review itself.
- macOS caps socket paths at 104 bytes; the agent bridge's socket lives under the editor's temp
  folder, so the driver uses short `/tmp/itd-*` folders.
- `ELECTRON_RUN_AS_NODE` in an inherited environment makes the editor start as plain Node; the
  driver scrubs it.
- A driver `wait:TEXT` passes at once if TEXT is already on screen from the old state. Wait for
  text only the new state shows.
- Driver `click:`/`expand:` only see Review rows on screen; a row scrolled out of view fails.
- On macOS, running an editor's binary inside its `.app` bundle with `--version` starts the whole
  app. Read the version from the bundle's `Info.plist` (`CFBundleShortVersionString`) instead.

## Analysis

- `gatherEntryFacts` language keys are `ts`, `go`, `python`, `csharp` (`entryLanguageOf` in
  `src/engine/entry-points.js`); an unknown key throws.
- VS Code turns a provider error, and an evicted call-hierarchy model, into an empty list. An empty
  caller answer from the editor is not proof of no callers.

## Shell

- The shell is zsh: an unquoted glob that matches nothing (`--include=*.js`) fails the whole
  command with `no matches found`. Quote globs: `--include='*.js'`.
- Unzipping the Roslyn package drops the exec bit; `chmod +x` the server binary or start it with
  `dotnet <dll>`.
- Never read a glob of task output files (`tasks/*.output`): one of them is your own, growing as
  you read it.
