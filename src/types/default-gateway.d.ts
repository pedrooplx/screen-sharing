declare module 'default-gateway' {
  interface GatewayResult {
    gateway: string;
    version?: string;
    int?: string;
  }
  export function gateway4async(): Promise<GatewayResult>;
  export function gateway6async(): Promise<GatewayResult>;
  export function gateway4sync(): GatewayResult;
  export function gateway6sync(): GatewayResult;
}
