#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int failed_event_sync = 0;

int unlink(const char *path) {
    int (*next)(const char *) = dlsym(RTLD_NEXT, "unlink");
    const char *phase = getenv("DECISION_OWNED_COMMIT_PHASE");
    const char *journal = getenv("DECISION_OWNED_COMMIT_JOURNAL");
    const char *logs = getenv("DECISION_OWNED_COMMIT_LOGS");
    if (phase && journal && logs && strcmp(phase, "cleanup-deferred") == 0 &&
        strncmp(path, logs, strlen(logs)) == 0 && strstr(path, ".snapshot-before") && access(journal, F_OK) == 0) {
        errno = EACCES; return -1;
    }
    return next(path);
}

int fsync(int file) {
    int (*next)(int) = dlsym(RTLD_NEXT, "fsync");
    const char *phase = getenv("DECISION_OWNED_COMMIT_PHASE");
    const char *event = getenv("DECISION_OWNED_COMMIT_EVENT");
    const char *journal = getenv("DECISION_OWNED_COMMIT_JOURNAL");
    if (!failed_event_sync && phase && event && journal && strcmp(phase, "rollback-start") == 0 && access(journal, F_OK) == 0) {
        char link[64], target[4096];
        int length = snprintf(link, sizeof(link), "/proc/self/fd/%d", file);
        ssize_t size = length > 0 ? readlink(link, target, sizeof(target) - 1) : -1;
        if (size >= 0) {
            target[size] = 0;
            if (strcmp(target, event) == 0) { failed_event_sync = 1; errno = EIO; return -1; }
        }
    }
    return next(file);
}

/* This library is compiled only inside an owned synthetic fixture. */
static int committed(const char *path) {
    int file = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (file < 0) return 0;
    struct stat metadata;
    char buffer[128 * 1024 + 1];
    int valid = fstat(file, &metadata) == 0 && S_ISREG(metadata.st_mode) &&
        metadata.st_uid == geteuid() && (metadata.st_mode & 077) == 0 &&
        metadata.st_nlink == 1 && metadata.st_size <= 128 * 1024;
    ssize_t size = valid ? read(file, buffer, sizeof(buffer) - 1) : -1;
    close(file);
    if (size < 0) return 0;
    buffer[size] = 0;
    return strstr(buffer, "\"state\":\"committed\"") != NULL;
}

int rename(const char *old_path, const char *new_path) {
    int (*next)(const char *, const char *) = dlsym(RTLD_NEXT, "rename");
    const char *phase = getenv("DECISION_OWNED_COMMIT_PHASE");
    const char *stats = getenv("DECISION_OWNED_COMMIT_STATS");
    const char *snapshot = getenv("DECISION_OWNED_COMMIT_SNAPSHOT");
    const char *journal = getenv("DECISION_OWNED_COMMIT_JOURNAL");
    int active = phase && stats && snapshot && journal && access(journal, F_OK) == 0;
    if (active && strcmp(phase, "before-stats") == 0 && strcmp(new_path, stats) == 0)
        kill(getpid(), SIGSTOP);
    if (active && failed_event_sync && strcmp(phase, "rollback-start") == 0 && strcmp(new_path, stats) == 0)
        kill(getpid(), SIGSTOP);
    if (active && strcmp(phase, "after-event") == 0 && strcmp(new_path, journal) == 0 && committed(old_path))
        kill(getpid(), SIGSTOP);
    int status = next(old_path, new_path), saved_errno = errno;
    if (status == 0 && active &&
        ((strcmp(phase, "after-stats") == 0 && strcmp(new_path, stats) == 0) ||
         (strcmp(phase, "after-snapshot") == 0 && strcmp(new_path, snapshot) == 0) ||
         (strcmp(phase, "after-commit") == 0 && strcmp(new_path, journal) == 0 && committed(journal))))
        kill(getpid(), SIGSTOP);
    errno = saved_errno;
    return status;
}
