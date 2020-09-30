var com_apemesh_echoService_echoWithAPICache = CdifUtil.loadFile(__dirname + '/com-apemesh-echoService-echoWithAPICache.js');
var com_apemesh_echoService_echo = CdifUtil.loadFile(__dirname + '/com-apemesh-echoService-echo.js');

module.exports = {
  com_apemesh_echoService_echo: com_apemesh_echoService_echo,
  com_apemesh_echoService_echoWithAPICache: com_apemesh_echoService_echoWithAPICache
};