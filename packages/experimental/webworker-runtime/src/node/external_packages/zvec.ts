/** Zvec requires a native Host; loading its SDK is unavailable in the Worker. */
import { notAvailableError } from '../notImplementedFail.ts'

/**
 * Reject an explicit native SDK request without creating an SDK or loading a binary.
 * @returns Never; throws the standard platform-unavailable error.
 */
export function loadZvec(): never {
  throw notAvailableError('@zvec/zvec', 'native SDK')
}
