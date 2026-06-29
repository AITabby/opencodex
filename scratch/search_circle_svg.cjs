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
          // Find all SVG circles or SVGs containing path/circle in the document
          const svgs = Array.from(document.querySelectorAll('svg'));
          return svgs.map((svg, i) => {
            const hasCircle = svg.querySelector('circle') !== null;
            const hasDash = svg.innerHTML.includes('dash');
            return {
              index: i,
              hasCircle,
              hasDash,
              parentTag: svg.parentElement ? svg.parentElement.tagName : 'none',
              parentClass: svg.parentElement ? svg.parentElement.className : '',
              outerHTMLSnippet: svg.outerHTML.slice(0, 300)
            };
          });
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
