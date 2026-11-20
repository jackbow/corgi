# Code highlighting verification

Measured on macOS arm64 with Bun 1.4.4, using
`bun tools/benchmarks/code_highlight.ts 10000`. These are single-run development
measurements, not release performance guarantees. The input is 10,000 TypeScript
function declarations with comments; results depend on language and content.

| Operation | Time |
| --- | ---: |
| First Dark+ highlight, including worker/grammar startup | 1,111 ms |
| First Light+ highlight in the existing worker | 509 ms |
| First Terminal highlight in the existing worker | 498 ms |
| Toggle background with cached tokens | <0.01 ms |
| Return to cached Dark+ | 0.05 ms |
| 100,000 cached line reads | 19.33 ms |

Cached scrolling and the return to Dark+ submitted zero worker jobs. Drawing
only requests cached spans or posts a worker job; Shiki runs in the worker.
The pending view remains plain text until the whole result arrives.

Process RSS was 9.3 MB before worker startup, 225.4 MB with all three token
palettes cached, and 43.2 MB after releasing the file, terminating the worker,
and requesting GC. RSS includes the worker, loaded grammars, caches, runtime
and allocator; this is not a retained-heap measurement. Large files therefore
have a material transient memory cost. Files over 50,000 lines or two million
characters stay plain text, and only the first 2,000 characters per line are
highlighted. Each file retains at most four palette variants.

A comparable compiled baseline using the original tracked sources and the
same native/web assets was 106,530,530 bytes; the highlighted build was
109,370,594 bytes: +2,840,064 bytes (2.71 MiB, 2.67%). Build metadata can change
the exact size.

## Checks and visual comparison

The full application unit suite, focused viewer integration, typechecking,
site tests, compiled binary build and all-language site build passed. A real
compiled binary displayed Dark+ function colors through its bundled worker.
The browser-target worker also highlighted TSX with network APIs blocked.

The broader viewer integration run finished with 31 passes and three failures.
The two agent-navigation/search assertions also fail against a compiled
original-source baseline. The remaining failure was a shutdown timeout in a
directory-inheritance test; its focused rerun passed. These failures were not
changed as part of highlighting.

Styled terminal captures compare the Settings sample under Dark+, Light+ and
Terminal. Each frame includes the same diff and chat sample on both palette
and Corgi backgrounds. To reproduce, open Settings → Code colors, then move
through the three palette options without confirming. Enter saves a palette;
Escape cancels the preview. The background toggle can be saved separately.

Native Ghostty screenshots could not be captured because app automation access
was denied. Interactive browser verification could not run because the browser
automation host was unavailable. The terminal captures and offline worker test
do not replace those visual checks.
