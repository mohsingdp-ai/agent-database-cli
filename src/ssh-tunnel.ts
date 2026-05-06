import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import net from "node:net";
import { Client, type ConnectConfig } from "ssh2";
import type {
  DatabaseConfig,
  DatabaseType,
  RedisClusterConnectionConfig,
  RedisNodeAddress,
  SshTunnelConfig
} from "./types.js";

export interface StartedSshTunnel {
  url: string;
  redisCluster?: RedisClusterConnectionConfig;
  close(): Promise<void>;
}

interface DatabaseEndpoint {
  host: string;
  port: number;
}

const DEFAULT_PORTS: Record<DatabaseType, number> = {
  mysql: 3306,
  postgres: 5432,
  redis: 6379,
  oracle: 1521,
  mongodb: 27017
};

export async function startSshTunnel(config: DatabaseConfig): Promise<StartedSshTunnel | undefined> {
  if (!config.sshTunnel) {
    return undefined;
  }

  if (config.type === "redis" && config.redisCluster) {
    return startRedisClusterSshTunnel(config);
  }

  const endpoint = parseDatabaseEndpoint(config.type, config.url);
  const ssh = new Client();
  const server = net.createServer((socket) => {
    ssh.forwardOut(socket.localAddress || "127.0.0.1", socket.localPort || 0, endpoint.host, endpoint.port, (error, stream) => {
      if (error) {
        socket.destroy(error);
        return;
      }
      socket.pipe(stream).pipe(socket);
    });
  });

  try {
    await connectSshClient(ssh, config.sshTunnel);
    const localPort = await listenLocal(server);
    const url = rewriteDatabaseUrl(config.type, config.url, "127.0.0.1", localPort);
    return {
      url,
      async close() {
        await closeServer(server);
        ssh.end();
      }
    };
  } catch (error) {
    await closeServer(server);
    ssh.end();
    throw error;
  }
}

async function startRedisClusterSshTunnel(config: DatabaseConfig): Promise<StartedSshTunnel> {
  const ssh = new Client();
  const servers: net.Server[] = [];

  try {
    await connectSshClient(ssh, config.sshTunnel!);

    const nodeAddressMap: Record<string, RedisNodeAddress> = {};
    const localNodes: string[] = [];

    for (const nodeUrl of config.redisCluster!.nodes) {
      const endpoint = parseRedisClusterNode(nodeUrl);
      const server = createForwardServer(ssh, endpoint.host, endpoint.port);
      servers.push(server);
      const localPort = await listenLocal(server);
      localNodes.push(rewriteDatabaseUrl("redis", nodeUrl, "127.0.0.1", localPort));
      nodeAddressMap[`${endpoint.host}:${endpoint.port}`] = { host: "127.0.0.1", port: localPort };
    }

    return {
      url: rewriteDatabaseUrl("redis", config.url, "127.0.0.1", extractPort(localNodes[0])),
      redisCluster: {
        nodes: localNodes,
        nodeAddressMap
      },
      async close() {
        await Promise.all(servers.map((server) => closeServer(server)));
        ssh.end();
      }
    };
  } catch (error) {
    await Promise.all(servers.map((server) => closeServer(server).catch(() => undefined)));
    ssh.end();
    throw error;
  }
}

function createForwardServer(ssh: Client, host: string, port: number): net.Server {
  return net.createServer((socket) => {
    ssh.forwardOut(socket.localAddress || "127.0.0.1", socket.localPort || 0, host, port, (error, stream) => {
      if (error) {
        socket.destroy(error);
        return;
      }
      socket.pipe(stream).pipe(socket);
    });
  });
}

export function rewriteDatabaseUrl(type: DatabaseType, url: string, host: string, port: number): string {
  if (type === "mongodb") {
    return rewriteMongoUrl(url, host, port);
  }

  const parsed = new URL(url);
  parsed.hostname = host;
  parsed.port = String(port);
  return parsed.toString();
}

function rewriteMongoUrl(url: string, host: string, port: number): string {
  if (isMongoMultiHostUrl(url)) {
    throw new Error("SSH 隧道暂不支持 MongoDB 多 host URL");
  }

  const parsed = new URL(url);
  parsed.hostname = host;
  parsed.port = String(port);
  return parsed.toString();
}

function parseDatabaseEndpoint(type: DatabaseType, url: string): DatabaseEndpoint {
  if (type === "mongodb" && isMongoMultiHostUrl(url)) {
    throw new Error("SSH 隧道暂不支持 MongoDB 多 host URL");
  }

  const parsed = new URL(url);

  const host = parsed.hostname;
  if (!host) {
    throw new Error("数据库 URL 必须包含 host 才能建立 SSH 隧道");
  }

  return {
    host,
    port: parsed.port ? Number(parsed.port) : DEFAULT_PORTS[type]
  };
}

function parseRedisClusterNode(url: string): DatabaseEndpoint {
  const parsed = new URL(url);
  if (!parsed.hostname) {
    throw new Error("Redis Cluster 节点 URL 必须包含 host");
  }

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : DEFAULT_PORTS.redis
  };
}

function extractPort(url: string): number {
  const parsed = new URL(url);
  return parsed.port ? Number(parsed.port) : DEFAULT_PORTS.redis;
}

async function connectSshClient(client: Client, tunnel: SshTunnelConfig): Promise<void> {
  const connectConfig = await buildConnectConfig(tunnel);
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      client.off("ready", onReady);
      client.off("error", onError);
    };

    client.once("ready", onReady);
    client.once("error", onError);
    client.connect(connectConfig);
  });
}

async function buildConnectConfig(tunnel: SshTunnelConfig): Promise<ConnectConfig> {
  const connectConfig: ConnectConfig = {
    host: tunnel.host,
    port: tunnel.port ?? 22,
    username: tunnel.username,
    readyTimeout: tunnel.readyTimeout
  };

  if (tunnel.password) {
    connectConfig.password = tunnel.password;
  }
  if (tunnel.privateKeyPath) {
    connectConfig.privateKey = await readFile(resolveHomePath(tunnel.privateKeyPath), "utf8");
  } else if (tunnel.privateKey) {
    connectConfig.privateKey = tunnel.privateKey;
  }
  if (tunnel.passphrase) {
    connectConfig.passphrase = tunnel.passphrase;
  }

  return connectConfig;
}

function listenLocal(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("本地 SSH 隧道端口监听失败"));
        return;
      }
      resolve(address.port);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function resolveHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return isAbsolute(path) ? path : path;
}

function isMongoMultiHostUrl(url: string): boolean {
  if (!url.startsWith("mongodb://")) {
    return false;
  }

  const authority = url.slice("mongodb://".length).split(/[/?#]/, 1)[0] ?? "";
  const hosts = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  return hosts.includes(",");
}
