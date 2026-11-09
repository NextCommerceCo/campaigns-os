// A top-level function declaration replaces window.fetch in a classic script,
// and is a module-local binding in a module.
function fetch(input) {
  return Promise.resolve(input);
}
