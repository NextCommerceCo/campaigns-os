// Synthetic offline-boundary worker: one fetch to the receiver, then report that it settled.
const kind = new URL(self.location.href).searchParams.get("kind");
const attempt = () => fetch(`RECEIVER/${kind}-worker`).then(() => "response", () => "error");
if (kind === "shared") self.onconnect = (event) => { const [port] = event.ports; attempt().then((outcome) => port.postMessage(outcome)); };
else attempt().then((outcome) => self.postMessage(outcome));
