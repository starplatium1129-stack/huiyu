/** Debug properties exposed by this comparison page; never installed as application globals. */
export interface ProbeCoreModel {
  getDrawableCount(): number;
  getDrawableId(index: number): string;
  getDrawableIndex(id: string): number;
  getDrawableVertexPositions(index: number): Float32Array;
  getDrawableVertexCount(index: number): number;
  getDrawableVertexIndexCount(index: number): number;
  getDrawableVertexIndices(index: number): Uint16Array;
  getDrawableMaskCounts(): Int32Array;
  getDrawableDynamicFlagIsVisible(index: number): boolean;
  getDrawableOpacity(index: number): number;
}

export interface ProbeWindow extends Window {
  __model?: { internalModel?: { coreModel?: ProbeCoreModel } };
  __state?: unknown;
}
