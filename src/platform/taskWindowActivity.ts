let readBusy = () => false
let reloadApproved = false
const approvedReloadEvents = new WeakSet<Event>()

export function registerTaskActivity(read: () => boolean) { readBusy = read }
export function windowTasksBusy() { return readBusy() }
export function approveTaskReload() { reloadApproved = true }
export function consumeTaskReloadApproval(event: Event) {
  if (approvedReloadEvents.has(event)) return true
  const approved = reloadApproved
  reloadApproved = false
  if (approved) approvedReloadEvents.add(event)
  return approved
}
