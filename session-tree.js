const vscode = require("vscode");

/**
 * TreeDataProvider backing the "Sessions" view in the Project Steersman panel.
 * Renders the manager's FIFO session list (oldest-first) with per-state icons
 * and a contextValue that gates the inline row actions.
 */
class SessionTreeProvider {
  constructor(manager) {
    this.manager = manager;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    manager.onDidChangeSessions(() => this._onDidChangeTreeData.fire());
  }

  getChildren() {
    return this.manager.list().map((session) => {
      const connected = session.state === "connected";
      const item = new vscode.TreeItem(session.id);
      item.description = connected ? session.url : this._stateText(session.state);
      item.iconPath = this._stateIcon(session.state);
      item.contextValue = "projectSteersmanSession";
      item.id = session.id;
      item.sessionId = session.id;
      item.tooltip = connected ? session.url : this._stateText(session.state);
      return item;
    });
  }

  getTreeItem(item) {
    return item;
  }

  _stateText(state) {
    switch (state) {
      case "connecting":
        return "connecting…";
      case "failed":
        return "failed";
      case "disconnected":
        return "disconnected";
      default:
        return state;
    }
  }

  _stateIcon(state) {
    switch (state) {
      case "connected":
        return new vscode.ThemeIcon("circle-filled");
      case "connecting":
        return new vscode.ThemeIcon("loading~spin");
      case "failed":
        return new vscode.ThemeIcon("error");
      default:
        return new vscode.ThemeIcon("circle-outline");
    }
  }
}

module.exports = { SessionTreeProvider };
