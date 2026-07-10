let count = 0;

export default function movableWorker(request: { terminate?: boolean }) {
  if (request.terminate === true) {
    return { result: 'terminated', count };
  }
  count++;
  return { result: 'idle', count };
}
