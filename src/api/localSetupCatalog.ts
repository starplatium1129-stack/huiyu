import catalog from '../../runtime-rs/src/control/setup-models.json'

/** The same pinned IDs feed the runtime and browser boundary. */
export const localSetupModelIds=new Set(catalog.files.map(file=>file.id))
