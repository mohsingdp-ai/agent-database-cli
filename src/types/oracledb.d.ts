declare module "oracledb" {
  export interface Connection {
    execute(
      command: string,
      binds?: unknown[],
      options?: { outFormat?: number; autoCommit?: boolean }
    ): Promise<{
      rows?: unknown[];
      rowsAffected?: number;
      metaData?: Array<{ name: string }>;
    }>;
    close(): Promise<void>;
  }

  export function getConnection(options: {
    user: string;
    password: string;
    connectString: string;
  }): Promise<Connection>;

  export const OUT_FORMAT_OBJECT: number;

  const oracledb: {
    getConnection: typeof getConnection;
    OUT_FORMAT_OBJECT: typeof OUT_FORMAT_OBJECT;
  };

  export default oracledb;
}
