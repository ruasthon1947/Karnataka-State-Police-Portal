import type { FirRecord } from "../lib/cases";
import { trainHotspotModel } from "../lib/hotspotModel";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<FirRecord[]>) => void) | null;
  postMessage: (value: unknown) => void;
};

workerScope.onmessage = (event) => {
  workerScope.postMessage(trainHotspotModel(event.data || []));
};
