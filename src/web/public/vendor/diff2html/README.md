# diff2html (vendored)

Vendored copy of [diff2html](https://github.com/rtfpessoa/diff2html) **3.4.56**, used by the
`/_git` diff viewer. Served from `/static/vendor/diff2html/` with the usual
`?v=${STATIC_VERSION}` cache-busting.

These files were previously loaded from an unpinned `cdn.jsdelivr.net/npm/diff2html` URL. That
made the diff viewer depend on the public internet at page load: a content blocker, a network
failure, or a cached bad response left `window.Diff2HtmlUI` undefined and broke the viewer. The
URL was also unpinned, so an upstream release could change behaviour with no deploy here. See #372.

`diff2html-ui-slim.min.js` bundles its own highlight.js, so no separate `hljs` script is needed.

## Updating

Files are taken verbatim from the npm tarball — do not hand-edit them.

```sh
VERSION=3.4.56
curl -s "https://registry.npmjs.org/diff2html/-/diff2html-$VERSION.tgz" -o d2h.tgz
# verify against the shasum published by the registry before extracting:
#   curl -s "https://registry.npmjs.org/diff2html/$VERSION" | jq -r .dist.shasum
#   sha1sum d2h.tgz
tar xzf d2h.tgz
cp package/bundles/js/diff2html-ui-slim.min.js .
cp package/bundles/css/diff2html.min.css .
cp package/LICENSE.md .
```

Bump the version in this file to match, and check the `/_git` page still renders a diff.

diff2html is MIT licensed; see `LICENSE.md`.
