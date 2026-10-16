interface ErrorResponse
{
    error: string;
    message: string;
    details?: unknown;
    platform_response?: MetingResult;
}