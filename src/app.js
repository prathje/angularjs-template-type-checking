angular.module('poc', [])
    .filter('fullName', function () {
        /** @param {Student} student */
        return function (student) {
            return student ? student.first_name + ' ' + student.last_name : '';
        };
    });
