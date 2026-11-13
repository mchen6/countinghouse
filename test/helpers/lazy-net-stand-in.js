// A loopback stand-in for the lazy-net-probe fixture (test/sandbox/40 and 09):
// "ok" at /, and a one-operation WSDL at /svc. On an ephemeral port, so no
// fixed port is taken.
const http = require('http');

const wsdl = (port) => `<?xml version="1.0"?>
<definitions name="Probe" targetNamespace="urn:probe" xmlns:tns="urn:probe" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns="http://schemas.xmlsoap.org/wsdl/">
  <message name="PingRequest"><part name="text" type="xsd:string"/></message>
  <message name="PingResponse"><part name="text" type="xsd:string"/></message>
  <portType name="ProbePort"><operation name="Ping"><input message="tns:PingRequest"/><output message="tns:PingResponse"/></operation></portType>
  <binding name="ProbeBinding" type="tns:ProbePort"><soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Ping"><soap:operation soapAction="Ping"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation></binding>
  <service name="ProbeService"><port name="ProbePort" binding="tns:ProbeBinding"><soap:address location="http://127.0.0.1:${port}/svc"/></port></service>
</definitions>`;

// -> Promise of {server, port, base, close()}.
async function startStandIn() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/svc')) { res.setHeader('content-type', 'text/xml'); return res.end(wsdl(server.address().port)); }
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {server, port, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r))};
}

module.exports = {startStandIn};
