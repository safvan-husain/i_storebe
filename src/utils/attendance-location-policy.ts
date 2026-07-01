export const ATTENDANCE_LOCATION_BASE_RADIUS_METERS = 100;
export const ATTENDANCE_LOCATION_MAX_EFFECTIVE_RADIUS_METERS = 1000;
export const ATTENDANCE_LOCATION_POLICY_VERSION = 2;

export type AttendanceLocationEvaluation = {
    distanceMeters: number;
    effectiveRadiusMeters: number;
    allowed: boolean;
    accuracyMeters: number;
    legacyMode: boolean;
};

export function isLegacyLocationPayload(source: Record<string, unknown>) {
    const value = source.accuracyMeters;
    return value === null || value === undefined || value === '';
}

export function resolveEffectiveRadiusMeters(
    accuracyMeters: number,
    baseRadiusMeters: number = ATTENDANCE_LOCATION_BASE_RADIUS_METERS,
    maxEffectiveRadiusMeters: number = ATTENDANCE_LOCATION_MAX_EFFECTIVE_RADIUS_METERS,
) {
    const safeAccuracy = Math.max(0, accuracyMeters);
    return Math.min(baseRadiusMeters + safeAccuracy, maxEffectiveRadiusMeters);
}

export function distanceMeters(
    from: { latitude: number; longitude: number },
    to: { latitude: number; longitude: number },
) {
    const earthRadiusMeters = 6371000;
    const toRadians = (value: number) => value * Math.PI / 180;
    const latitudeDelta = toRadians(to.latitude - from.latitude);
    const longitudeDelta = toRadians(to.longitude - from.longitude);
    const fromLatitude = toRadians(from.latitude);
    const toLatitude = toRadians(to.latitude);
    const a = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function evaluateAttendanceLocation(input: {
    latitude: number;
    longitude: number;
    accuracyMeters?: number;
    branchLatitude: number;
    branchLongitude: number;
    baseRadiusMeters?: number;
    maxEffectiveRadiusMeters?: number;
}): AttendanceLocationEvaluation {
    const baseRadiusMeters = input.baseRadiusMeters ?? ATTENDANCE_LOCATION_BASE_RADIUS_METERS;
    const maxEffectiveRadiusMeters = input.maxEffectiveRadiusMeters
        ?? ATTENDANCE_LOCATION_MAX_EFFECTIVE_RADIUS_METERS;
    const legacyMode = input.accuracyMeters === undefined;
    const accuracyMeters = legacyMode ? 0 : Math.max(0, input.accuracyMeters ?? 0);
    const distanceMetersValue = distanceMeters(
        { latitude: input.latitude, longitude: input.longitude },
        { latitude: input.branchLatitude, longitude: input.branchLongitude },
    );
    const effectiveRadiusMeters = legacyMode
        ? baseRadiusMeters
        : resolveEffectiveRadiusMeters(accuracyMeters, baseRadiusMeters, maxEffectiveRadiusMeters);

    return {
        distanceMeters: distanceMetersValue,
        effectiveRadiusMeters,
        allowed: distanceMetersValue <= effectiveRadiusMeters,
        accuracyMeters,
        legacyMode,
    };
}

export function serializeAttendanceLocationPolicy() {
    return {
        version: ATTENDANCE_LOCATION_POLICY_VERSION,
        baseRadiusMeters: ATTENDANCE_LOCATION_BASE_RADIUS_METERS,
        maxEffectiveRadiusMeters: ATTENDANCE_LOCATION_MAX_EFFECTIVE_RADIUS_METERS,
    };
}
