const net = require('node:net');
function installNetworkGuard(simulateFetch = () => undefined) {
  const violations = [];
  const local = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
  function reject(host) {
    violations.push({ host, at: new Date().toISOString() });
    throw Error(`SANDBOX blocked external network: ${host}`);
  }
  const originalFetch = global.fetch;
  global.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!local(url.hostname)) {
      const simulated = simulateFetch(url, init);
      if (simulated !== undefined) return Promise.resolve(simulated);
      reject(url.hostname);
    }
    return originalFetch(input, init);
  };
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof first === 'object' ? first : { host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    const host = options.host ?? options.hostname ?? 'localhost';
    if (!options.path && !local(host)) reject(host);
    return originalConnect.apply(this, args);
  };
  return violations;
}
module.exports = { installNetworkGuard };
