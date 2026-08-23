"""Domain error types mapped to consistent JSON error responses."""


class DomainError(Exception):
    status_code: int = 400
    code: str = "BAD_REQUEST"

    def __init__(self, message: str, code: str | None = None, status_code: int | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code


class NotFoundError(DomainError):
    status_code = 404
    code = "NOT_FOUND"


class ValidationError(DomainError):
    status_code = 400
    code = "VALIDATION_ERROR"


class ConflictError(DomainError):
    status_code = 409
    code = "CONFLICT"
