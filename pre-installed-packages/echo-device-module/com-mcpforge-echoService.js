var com_mcpforge_echoService_echoAsync = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-echoService-echoAsync.js');
var com_mcpforge_echoService_echoWithAPICache = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-echoService-echoWithAPICache.js');
var com_mcpforge_echoService_echo = McpForgeUtil.loadFile(__dirname + '/com-mcpforge-echoService-echo.js');

module.exports = {
  com_mcpforge_echoService_echo: com_mcpforge_echoService_echo,
  com_mcpforge_echoService_echoWithAPICache: com_mcpforge_echoService_echoWithAPICache,
  com_mcpforge_echoService_echoAsync: com_mcpforge_echoService_echoAsync
};