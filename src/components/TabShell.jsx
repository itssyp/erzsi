import { useState } from 'react'

/**
 * TabShell component to manage tabbed views.
 * 
 * @param {Object} props
 * @param {Array} props.tabs - Array of { id, label, component }
 * @param {string} [props.defaultTabId] - Initial active tab ID
 * @param {string} [props.className] - Optional container class
 */
export function TabShell({ tabs, defaultTabId, className = '' }) {
  const [activeTabId, setActiveTabId] = useState(defaultTabId || (tabs.length > 0 ? tabs[0].id : null))

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0]

  return (
    <div className={`tab-shell ${className}`}>
      <div className="tab-bar">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            className={`tab-btn ${activeTabId === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTabId(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="tab-content">
        {activeTab && activeTab.component}
      </div>
    </div>
  )
}
