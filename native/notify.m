#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>
#import <CoreServices/CoreServices.h>
#include <stdio.h>
#include <unistd.h>

static void reply(NSDictionary *message) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

@interface Notifications : NSObject <NSApplicationDelegate, UNUserNotificationCenterDelegate>
@property(nonatomic, strong) NSMutableOrderedSet<NSString *> *identifiers;
@end

@implementation Notifications
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
    center.delegate = self;
    self.identifiers = [NSMutableOrderedSet orderedSet];
    [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(clicked:)
        name:@"computer.corgi.notification.clicked" object:nil];
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--check"]) {
        [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
            reply(@{@"bundle": NSBundle.mainBundle.bundleIdentifier ?: @"", @"authorization": @(settings.authorizationStatus)});
            exit(0);
        }];
        return;
    }
    [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert completionHandler:^(BOOL granted, NSError *error) {
        reply(@{@"ready": @(granted && !error)});
        if (!granted || error) exit(1);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            char *line = NULL;
            size_t capacity = 0;
            while (getline(&line, &capacity, stdin) > 0) {
                @autoreleasepool {
                    NSData *data = [[NSString stringWithUTF8String:line] dataUsingEncoding:NSUTF8StringEncoding];
                    NSDictionary *message = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
                    if (![message isKindOfClass:NSDictionary.class]) continue;
                    NSString *identifier = message[@"id"], *title = message[@"title"], *body = message[@"body"], *subtitle = message[@"subtitle"];
                    if (![identifier isKindOfClass:NSString.class] || identifier.length > 128 ||
                        ![title isKindOfClass:NSString.class] || ![body isKindOfClass:NSString.class]) continue;
                    dispatch_async(dispatch_get_main_queue(), ^{
                        UNMutableNotificationContent *content = [UNMutableNotificationContent new];
                        content.title = title;
                        content.body = body;
                        if ([subtitle isKindOfClass:NSString.class]) content.subtitle = subtitle;
                        [self.identifiers addObject:identifier];
                        if (self.identifiers.count > 128) {
                            [center removeDeliveredNotificationsWithIdentifiers:@[self.identifiers.firstObject]];
                            [self.identifiers removeObjectAtIndex:0];
                        }
                        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:nil];
                        [center addNotificationRequest:request withCompletionHandler:nil];
                    });
                }
            }
            free(line);
            dispatch_async(dispatch_get_main_queue(), ^{
                [center removeDeliveredNotificationsWithIdentifiers:self.identifiers.array];
                [NSApp terminate:nil];
            });
        });
    }];
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response
        withCompletionHandler:(void (^)(void))completionHandler {
    NSString *identifier = response.notification.request.identifier;
    // macOS may deliver the click to another instance of our helper app.
    if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier])
        [NSDistributedNotificationCenter.defaultCenter postNotificationName:@"computer.corgi.notification.clicked"
            object:identifier userInfo:nil deliverImmediately:YES];
    completionHandler();
}
- (void)clicked:(NSNotification *)notification {
    NSString *identifier = notification.object;
    if ([self.identifiers containsObject:identifier]) {
        reply(@{@"clicked": identifier});
        [self.identifiers removeObject:identifier];
        if ([NSProcessInfo.processInfo.environment[@"TERM_PROGRAM"] isEqualToString:@"ghostty"]) {
            const char *tty = ttyname(3);
            if (tty) {
                NSString *device = [NSString stringWithUTF8String:tty];
                NSCharacterSet *unsafe = [[NSCharacterSet characterSetWithCharactersInString:@"/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-."] invertedSet];
                if ([device rangeOfCharacterFromSet:unsafe].location == NSNotFound) {
                    NSString *script = [NSString stringWithFormat:@"tell application \"Ghostty\"\nrepeat with candidate in terminals\nif tty of candidate is \"%@\" then\nfocus candidate\nactivate\nreturn\nend if\nend repeat\nend tell", device];
                    NSTask *task = [NSTask new];
                    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/osascript"];
                    task.arguments = @[@"-e", script];
                    task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
                    task.standardError = NSFileHandle.fileHandleWithNullDevice;
                    [task launchAndReturnError:nil];
                }
            }
        }
    }
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        LSRegisterURL((__bridge CFURLRef)NSBundle.mainBundle.bundleURL, true);
        NSApplication *app = NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        __attribute__((objc_precise_lifetime)) Notifications *delegate = [Notifications new];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
