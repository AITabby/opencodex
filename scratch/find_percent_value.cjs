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
          const results = [];
          
          function traverse(node, depth = 0) {
            if (!node || depth > 100) return;
            
            let s = node.memoizedState;
            while (s) {
              const val = s.memoizedState;
              if (val && typeof val === 'object') {
                try {
                  // Check if this object contains "conversations" or looks like the Codex store
                  if (val.conversations instanceof Map) {
                    const convs = [];
                    for (const [id, conv] of val.conversations.entries()) {
                      if (conv.latestTokenUsageInfo) {
                        convs.push({
                          id,
                          tokenUsage: conv.latestTokenUsageInfo
                        });
                      }
                    }
                    results.push({
                      type: 'store',
                      convs
                    });
                  }
                } catch(e) {
                  results.push({ error: e.message });
                }
              }
              s = s.next;
            }
            
            if (node.child) traverse(node.child, depth + 1);
            if (node.sibling) traverse(node.sibling, depth + 1);
          }
          
          traverse(startNode);
          return results;
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
