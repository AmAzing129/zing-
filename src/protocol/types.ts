export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcError = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcMessage = JsonRpcSuccess | JsonRpcError | JsonRpcNotification;

export type AppServerInfo = {
  agentId: string;
  name: string;
  modelId: string;
};
