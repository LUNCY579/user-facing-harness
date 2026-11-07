/**
 * The absolute pathnames the Host registers the export routes under and the
 * document-relative forms the browser addresses; see
 * .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md.
 */

/** Absolute registration path for the ZIP download route. */
export const SESSION_LOG_EXPORT_PATH = '/api/session.export'

/** Browser-relative form of {@link SESSION_LOG_EXPORT_PATH}. */
export const SESSION_LOG_EXPORT_ROUTE = SESSION_LOG_EXPORT_PATH.slice(1)

/** Absolute registration path for the Markdown copy route. */
export const SESSION_MARKDOWN_EXPORT_PATH = '/api/session.markdown'

/** Browser-relative form of {@link SESSION_MARKDOWN_EXPORT_PATH}. */
export const SESSION_MARKDOWN_EXPORT_ROUTE = SESSION_MARKDOWN_EXPORT_PATH.slice(1)

/** Absolute registration path for the structured trajectory export route. */
export const SESSION_TRAJECTORY_EXPORT_PATH = '/api/session.trajectory'

/** Browser-relative form of {@link SESSION_TRAJECTORY_EXPORT_PATH}. */
export const SESSION_TRAJECTORY_EXPORT_ROUTE = SESSION_TRAJECTORY_EXPORT_PATH.slice(1)
