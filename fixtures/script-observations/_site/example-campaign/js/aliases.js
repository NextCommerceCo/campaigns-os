// Aliases resolve through const bindings and destructuring, never through let or var.
const store = sessionStorage;
const { localStorage: persistent } = window;
const prefix = 'next-checkout-store__';
const root = globalThis;
const sdk = window.next;
const debug = window.nextDebug;
store.removeItem('next-order');
persistent.setItem(`${prefix}${location.hostname}`, '{}');
root.fetch = (input) => Promise.resolve(input);
sdk._state.cart = debug.stores.cart;
let mutable = sessionStorage;
mutable = { getItem() { return null; } };
mutable.getItem('next-order');
export { storeOf };
function storeOf() { return store; }
