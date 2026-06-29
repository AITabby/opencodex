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
          const root = window.__codexRoot;
          if (!root || !root._internalRoot) return { error: 'No React root found' };
          
          const startNode = root._internalRoot.current;
          const foundStates = [];
          
          function traverse(node, depth = 0) {
            if (!node || depth > 100) return;
            
            let s = node.memoizedState;
            while (s) {
              const val = s.memoizedState;
              if (val && typeof val === 'object') {
                try {
                  // Check if it contains relevant keys
                  const str = JSON.stringify(val);
                  if (str && (str.includes('token') || str.includes('limit') || str.includes('percent') || str.includes('context'))) {
                    // Try to extract only relevant keys to avoid circular structure errors
                    const keys = Object.keys(val);
                    foundStates.push({
                      type: node.elementType ? (node.elementType.name || String(node.elementType)) : 'unknown',
                      keys: keys.filter(k => typeof val[k] !== 'function'),
                      valuesSample: keys.filter(k => typeof val[k] !== 'function').reduce((acc, k) => {
                        acc[k] = typeof val[k] === 'object' ? String(val[k]).slice(0, 100) : val[k];
                        return acc;
                      }, {})
                    });
                  }
                } catch(e) {}
              }
              s = s.next;
            }
            
            if (node.child) traverse(node.child, depth + 1);
            if (node.sibling) traverse(node.sibling, depth + 1);
          }
          
          traverse(startNode);
          return foundStates.slice(0, 30);
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
        console.log(JSON.stringify(res.result, null, 2));
        ws.close();
      }
    });
  });
