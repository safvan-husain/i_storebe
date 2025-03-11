export const getISTDate = (): Date => {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000; // Convert 5.5 hours to milliseconds
    return new Date(now.getTime() + istOffset);
};