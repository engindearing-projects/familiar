// Shared type definitions — JSDoc for CLI, referenced by mobile TypeScript.
// These define the canonical shapes used across all Familiar interfaces.

/**
 * @typedef {'user' | 'assistant' | 'system'} MessageRole
 */

/**
 * @typedef {Object} Message
 * @property {string} id
 * @property {MessageRole} role
 * @property {string} text
 * @property {number} [timestamp]
 */

/**
 * @typedef {'connecting' | 'connected' | 'disconnected'} ConnectionState
 */

/**
 * @typedef {'task_update' | 'code_change' | 'decision' | 'blocker' | 'preference' | 'insight' | 'chat_exchange'} ObservationType
 */

/**
 * @typedef {'jira_cron' | 'chat' | 'cli-oneshot' | 'tui' | 'mcp' | 'code_review' | 'manual' | 'mobile'} ObservationSource
 */

/**
 * @typedef {Object} Observation
 * @property {string} id
 * @property {ObservationType} type
 * @property {string} timestamp - ISO 8601
 * @property {string} [project]
 * @property {string} summary
 * @property {string} [details]
 * @property {string[]} [tags]
 * @property {ObservationSource} [source]
 */

/**
 * @typedef {Object} UserProfile
 * @property {string} [name]
 * @property {string} [role]
 * @property {string} [org]
 * @property {string} [email]
 * @property {string} [timezone]
 * @property {{ start: string, end: string }} [workHours]
 * @property {{ slack: boolean, telegram: boolean, cli: boolean }} [channels]
 */

/**
 * @typedef {Object} Preference
 * @property {string} key
 * @property {*} value
 * @property {string} learned_at - ISO 8601
 * @property {string} [source]
 */

/**
 * @typedef {Object} ServiceStatus
 * @property {string} label - launchd label
 * @property {string} displayName
 * @property {boolean} running
 * @property {boolean} healthy
 * @property {number|null} pid
 * @property {number|null} latencyMs
 * @property {boolean} managed - whether we can start/stop it
 */

// Re-export for convenient importing (no actual values, just documentation)
export {};
