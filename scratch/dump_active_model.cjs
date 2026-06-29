const WebSocket = require('ws');

fetch("http://127.0.0.1:8315/json")
  .then(res => res.json())
  .then((targets) => {
    const pageTarget = targets.find(t => t.type === "page" && t.url.includes("index.html") && !t.url.includes("avatar-overlay") && !t.url.includes("initialRoute"));
    if (!pageTarget) {
      console.log("No main page target found.");
      return;
    }
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    ws.on('open', () => {
      const evalScript = `
        (() => {
          const footer = document.querySelector('div[class*="_footer_"]');
          if (!footer) return { error: 'Footer not found' };
          return {
            footerText: footer.innerText
          };
        })()
      `;
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: evalScript,
          returnByValue: true
        }
      }));
    });
    ws.on('message', (data) => {
      const res = JSON.parse(data.toString());
      if (res.id === 1) {
        console.log(JSON.stringify(res.result.result.value, null, 2));
        ws.close();
      }
    });
  });
