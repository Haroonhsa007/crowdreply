// eslint-disable-next-line @typescript-eslint/no-require-imports -- Legacy consumers require a synchronous CommonJS callable export.
const upstream = require('minimatch');

// Older ESLint plugins call the CommonJS export directly. Copy the helpers onto
// a separate function so the upstream module remains untouched.
const legacy = Object.assign(
  (path, pattern, options) => upstream.minimatch(path, pattern, options),
  upstream.minimatch,
);

// import/no-internal-modules only uses makeRe(...).test(path). Minimatch 11
// removed regex generation; delegate this narrow interface to its safe matcher.
legacy.makeRe = (pattern, options) => {
  const matcher = new upstream.Minimatch(pattern, options);
  return { test: (path) => matcher.match(path) };
};

module.exports = legacy;
