/** The configuration loader owns defaults and validation; consumers reuse its actual result. */
export type GatewayConfig = ReturnType<typeof import('./config').loadGatewayConfig>;
export type RuntimePaths = GatewayConfig['RUNTIME'];
