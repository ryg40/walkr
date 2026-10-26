# Double input rules

Double and Coinflip accept only prepared static copies that pass these rules.
`walkr-double create`, `walkr-double session create` and each attach of a new pair run the check.
The check returns either a complete two-pane result or the first diagnostic. It never accepts a partial comparison.
The words that Double uses are in the [glossary](../GLOSSARY.md#double).

## Input

The manifest has this shape. In Node, `validateDoubleInput` from `src/double-input.js` runs the same check.

```js
import { validateDoubleInput } from "./src/double-input.js";

const result = await validateDoubleInput({
  comparisonId: "landing-trial-1",
  label: "Landing proposals",
  panes: {
    left: {
      label: "Proposal A",
      original: {
        entry: "/artifacts/a/index.html",
        files: [
          { path: "/artifacts/a/index.html", sha256: "<64 lowercase hex characters>" },
          { path: "/artifacts/a/site.css", sha256: "<64 lowercase hex characters>" },
          { path: "/artifacts/a/hero.png", sha256: "<64 lowercase hex characters>" },
        ],
      },
      copy: {
        root: "/disposable/left",
        entry: "index.html",
        assets: ["site.css", "hero.png"],
      },
    },
    right: {
      label: "Proposal B",
      original: {
        entry: "/artifacts/b/index.html",
        files: [{ path: "/artifacts/b/index.html", sha256: "<64 lowercase hex characters>" }],
      },
      copy: { root: "/disposable/right", entry: "index.html", assets: [] },
    },
  },
});
```

The hash placeholders are not valid inputs. Supply hashes recorded before copy preparation or annotation.
The right example represents a self-contained HTML entry without asset files.

- All shown object fields are required. Unknown fields are rejected. Only `left` and `right` panes exist.
- `comparisonId` and component IDs are nonempty strings without whitespace or control characters. Labels remain separate, readable strings.
- `original.entry` names the original artifact. `original.files` lists explicit paths and their baseline SHA-256 hashes, including the entry.
- The preparer declares every original file whose provenance matters. The validator checks every declared baseline, but cannot prove declaration completeness.
- `copy.root` names an existing isolated folder. `copy.entry` and `copy.assets` are relative file paths, not paths into originals.
- Copy folders contain only the entry, declared assets, and their parent directories. Extra files and empty extra directories are rejected.
- The validator enumerates these folders only to reject extra entries. It does not discover, copy, fetch, or prepare dependencies.
- Original paths and copy roots use canonical absolute paths without traversal or trailing slashes. Files must be regular files.
- Relative path segments use `[A-Za-z0-9_-][A-Za-z0-9._-]*`. Dot segments, spaces, percent escapes, backslashes, and URL suffixes are unsupported.
- The original entry can be shared between panes. Neither original files nor copy files may alias a copy file.
- Copy folders must be distinct and non-overlapping. Declared original files must reside outside both copy folders.
- Symlinks in paths or copy contents are rejected. Every declared file must have exactly one hard link.

The interface never returns a writable original target or writes a file. Original paths in the result remain descriptive provenance.

## Component markers

```html
<section data-double-id="hero" data-container="Hero introduction">
  <h1>A proposal</h1>
  <img src="hero.png" alt="Proposal illustration">
</section>
```

A component requires both attributes on the same element. An empty `data-double-id` explicitly declares an invalid component.
A `data-container` label without `data-double-id` is not a Double declaration and never becomes a component automatically.
An entry containing only such labels is rejected because it has no components.

Duplicate IDs within a pane are rejected. The same ID can appear once in each opposite pane.

### Nested scopes

A marked region can contain other marked regions only when it declares an explicit scope with `data-double-scope`:

```html
<section data-double-id="report-whole" data-double-scope="group" data-container="Whole report">
  <div data-double-id="report-frame" data-double-scope="frame" data-container="Frame only" class="report">
    <ul><li data-double-id="item-a" data-container="Item A">…</li></ul>
  </div>
</section>
```

| Scope | Meaning | Rule |
| --- | --- | --- |
| none | An ordinary component | It cannot contain another marked region. |
| `group` | The whole component, including every marked region inside it | Any element. |
| `frame` | Only the border, background, and padding of a wrapper; its children stay | Must be a `div`. |

Any other `data-double-scope` value rejects with `INVALID_SCOPE`. A marked region inside an ordinary component still rejects with `NESTED_COMPONENT`.
The validated component gains `scope` when declared and `parentId` (the nearest marked ancestor) when nested.
Inputs without `data-double-scope` produce the same components as before.
Every explicit `data-double-id` start-tag declaration must remain on exactly one validated element.
The ID and label must appear together on that original start tag.
Parser-discarded or merged declarations are rejected, including orphan table cells and repeated `html` or `body` markers.
A later merged start tag cannot supply a missing component label.
Comments, quoted attribute values, escaped text, and CSS strings that mention markers do not declare components.

Identity is the structured tuple `{ comparisonId, pane, componentId }`.
Labels, paths, hashes, and DOM positions are not identity. Line and column locations are informational only.
Repeated validation preserves identity if the caller preserves the comparison ID, pane assignment, and component IDs.
There is no identity registry or automatic ID generation.

## Supported input subset

Double supports static UTF-8 HTML, CSS, and raster images only.
It does not claim general dependency discovery or browser compatibility validation.

| Area | Supported forms |
| --- | --- |
| Entry | One `.html` or `.htm` file per pane; full documents and HTML fragments |
| HTML structure | `html head body title meta link style main header footer nav aside section article div span` |
| HTML text | `h1 h2 h3 h4 h5 h6 p ul ol li dl dt dd figure figcaption blockquote pre code br hr strong em b i u s small sub sup mark time abbr address q cite` |
| HTML controls and tables | `a img details summary button table caption colgroup col thead tbody tfoot tr th td` |
| Common attributes | `id class title lang dir hidden inert role tabindex style`, plus inert `data-*` and `aria-*` attributes |
| Element attributes | `a: href`; `img: src alt width height loading decoding`; `ol: start reversed type`; `li: value`; `time: datetime`; `details: open name`; `button: type disabled` |
| Table attributes | `col/colgroup: span`; `td: colspan rowspan headers`; `th: colspan rowspan scope headers abbr` |
| Metadata | `<meta charset="utf-8">`, viewport metadata, description metadata; no refresh or other metadata forms |
| Stylesheets | `<link rel="stylesheet" href="site.css">`; optional CSS `type` and `media`; all declared CSS files are parsed |
| Images | `<img src="image.png">`; `.png .jpg .jpeg .gif .webp .avif` file extensions |
| Links | `<a href="#section">` only; fragment characters are ASCII letters, digits, `_ . : -` |
| Inline CSS | `<style>` and `style` attributes; optional CSS `type` and `media` on style elements |
| CSS dependencies | Literal `url(image.png)` or `url("image.png")`; plain `@import "site.css"` or `@import url("site.css")` |
| CSS custom properties | URL-free values, including URL-free `var()` fallbacks; no literal URL nodes anywhere within a custom-property value |
| CSS grouping | `@media`, `@supports`, `@layer`, `@container`, `@keyframes`, `@-webkit-keyframes` |

Each HTML or CSS dependency must name a declared asset inside its own copy folder.
References resolve relative to the referencing file, including imported stylesheets. One leading `./` is accepted.
All declared CSS files are checked, including unused files. Import cycles do not recurse or cause fetching.
Missing declared files are rejected before parsing. Unlisted references require an explicit asset declaration.

CSS accepts common color, gradient, transform, filter, sizing, counter, and math functions.
The exact function allowlist is `CSS_FUNCTIONS` in `src/double-input.js`. Unknown functions and at-rules fail closed.
Custom-property values cannot contain literal `url()` nodes, including URLs nested in functions or `var()` fallbacks.
This restriction applies to stylesheets, style elements, and style attributes, even when the property or fallback is unused.
CSS resolves custom-property URLs at consumption, which can occur in another stylesheet. The validator does not resolve the CSS cascade.
URL-free custom properties remain supported. Strings and comments containing the text `url(...)` are not URL nodes.
Literal URL fallbacks in ordinary, non-custom declarations remain supported and resolve relative to that declaration's file.
The CSS parser must not recover unparsed tokens. Backslash escapes are rejected, including escapes inside comments.

Unsupported inputs include scripts, event handlers, custom elements, forms, frames, SVG, templates, media, fonts, and extra HTML pages.
Other unsupported forms include `srcset`, preload links, base URLs, page navigation, remote URLs, data URLs, and file URLs.
CSS `image-set()`, `image()`, `paint()`, dynamic URLs, qualified imports, `@font-face`, and escaped syntax are unsupported.
Unknown HTML elements and attributes fail closed rather than bypassing dependency checks.
HTML parser errors are rejected, except the missing-doctype error for fragments. Normal HTML tree construction still applies to unmarked content.
Marked start tags must survive tree construction without declaration loss or merging. Valid table cells and implicit table bodies remain supported.

Images are opaque bytes with supported extensions. The validator does not decode images or prove their format or visual correctness.
No HTML, CSS, JavaScript, or browser rendering runs during validation.

## Results and diagnostics

Success returns:

```js
{
  ok: true,
  comparison: {
    id: "landing-trial-1",
    label: "Landing proposals",
    panes: {
      left: {
        id: "left",
        label: "Proposal A",
        original: {
          entry: "/artifacts/a/index.html",
          files: [{ path: "/artifacts/a/index.html", baselineSha256: "...", currentSha256: "..." }],
        },
        copy: {
          root: "/disposable/left",
          entry: "index.html",
          files: [{ path: "index.html", sha256: "..." }],
        },
        components: [{
          id: "hero",
          label: "Hero introduction",
          identity: { comparisonId: "landing-trial-1", pane: "left", componentId: "hero" },
          location: { file: "index.html", line: 1, column: 1 },
        }],
      },
      right: { /* same fields for the right pane */ },
    },
  },
  diagnostics: [],
}
```

The example abbreviates the file lists. Actual results include every declared original and copy file.
Original baseline hashes and observed hashes remain separate from current copy hashes.
A copy can differ from its original, for example after annotation. The original must still match its baseline.

Failure returns `{ ok: false, diagnostics: [diagnostic] }` without `comparison` or any accepted pane.
Only the first error is returned. Fix it and validate the complete pair again.

Every diagnostic includes `code`, `message`, `pane`, `file`, and `componentId`. Unavailable context fields are `null`.
HTML errors include line and column when known. File access errors include `fsCode` without exposing raw exceptions.
Unlisted dependency errors include `reference`. Standalone CSS errors have no component because stylesheets can affect many regions.

| Codes | Meaning |
| --- | --- |
| `INPUT_SHAPE`, `INVALID_ID`, `INVALID_LABEL` | Missing, extra, or invalid declarations |
| `INVALID_PATH`, `COPY_OVERLAP`, `SOURCE_COPY_ALIAS` | Invalid path spelling, overlapping folders, or source/copy identity alias |
| `SYMLINK`, `HARDLINK`, `FILE_TYPE` | Unsupported link or file type |
| `MISSING_FILE`, `FILE_ACCESS`, `UNDECLARED_FILE` | Missing/unreadable paths or extra copy contents |
| `ORIGINAL_CHANGED`, `FILE_CHANGED` | Baseline mismatch or observed concurrent file change |
| `DUPLICATE_COMPONENT`, `NESTED_COMPONENT`, `INVALID_SCOPE`, `NO_COMPONENTS` | Invalid region set |
| `REMOTE_REFERENCE`, `OUTSIDE_COPY`, `UNDECLARED_ASSET` | Remote, out-of-folder, or unlisted dependency |
| `UNSUPPORTED_ENTRY`, `UNSUPPORTED_ASSET`, `UNSUPPORTED_REFERENCE` | Unsupported entry, asset type, or URL form |
| `INVALID_HTML`, `INVALID_CSS`, `UNSUPPORTED_HTML`, `UNSUPPORTED_CSS`, `UNSUPPORTED_ENCODING` | Unsupported or unparseable content |

Discarded or merged component declarations return `INVALID_HTML` unless another component or content check fails first.
URL-valued custom properties return `UNSUPPORTED_CSS`, including local URLs whose files exist.

Expected input and filesystem errors return diagnostics. Unexpected programming errors reject the promise.

## Isolation limits and non-integration

Validation uses read-only file handles, checks parent paths, rejects links, and compares device/inode identities.
It checks file metadata before reading, after reading, and before returning success.

This is a point-in-time check for trusted, quiescent disposable folders on the local Linux filesystem.
It does not lock files, protect against adversarial path-replacement races, or certify future writes as safe.
Bind mounts and filesystem-specific alias mechanisms are not comprehensively detected.
Do not expose this function as an untrusted path-reading service or use its result as a write authorization.
The validator has no resource quotas and reads declared files into memory.

Original declaration completeness, preparation history, and baseline trust remain the preparer's responsibility.
Validation cannot prove that an annotated copy came from the declared original.
No production serving policy or MIME-type behavior is tested.

## Parser dependencies

The check uses `parse5` for HTML and `css-tree` for CSS. No browser and no script runs during the check.
`parse5` needs Node 20.19.0 or newer.

## Tests

`test/double-input.test.js` checks accepted and refused inputs. It also checks that the original and copy hashes do not change.
