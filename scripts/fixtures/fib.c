#include <stdio.h>

int fib(int n) {
    if (n <= 1) return n;
    return fib(n - 1) + fib(n - 2);
}

int main(void) {
    int i;
    int a[8];
    for (i = 0; i < 8; i++) a[i] = fib(i);
    for (i = 0; i < 8; i++) printf("%d ", a[i]);
    printf("\n");
    return 0;
}
