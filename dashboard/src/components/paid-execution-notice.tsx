export function PaidExecutionNotice() {
  return (
    <p className="notice warning">
      Paid provider execution is currently blocked pending verified billing
      limits. Saving a key configures access but does not enable paid calls.
    </p>
  );
}
