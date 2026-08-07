var com_countinghouse_echoService_echoAsync = CHUtil.loadFile(__dirname + '/com-countinghouse-echoService-echoAsync.js');
var com_countinghouse_echoService_echoWithAPICache = CHUtil.loadFile(__dirname + '/com-countinghouse-echoService-echoWithAPICache.js');
var com_countinghouse_echoService_echo = CHUtil.loadFile(__dirname + '/com-countinghouse-echoService-echo.js');

module.exports = {
  com_countinghouse_echoService_echo: com_countinghouse_echoService_echo,
  com_countinghouse_echoService_echoWithAPICache: com_countinghouse_echoService_echoWithAPICache,
  com_countinghouse_echoService_echoAsync: com_countinghouse_echoService_echoAsync
};