/** Only the development shell needs React Refresh, style injection and HMR. */
export function devShellCsp() {
  let server;
  return {
    name: 'wrenyard-dev-shell-csp', apply: 'serve',
    configureServer(value) { server = value; },
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        if (context.path !== '/renderer/index.html') return html;
        const address = server.httpServer.address();
        const port = typeof address === 'object' && address ? address.port : server.config.server.port;
        const csp = `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${port};`;
        return html.replace(/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/i, `$1${csp}$2`);
      },
    },
  };
}
