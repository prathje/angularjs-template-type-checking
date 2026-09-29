angular.module('poc').directive('studentCard', function () {
    return {
        restrict: 'E',
        templateUrl: 'src/student-card/student-card.html',
        scope: {
            student: '<',
            onEdit: '&',
            title: '@',
        },
        /** @param {ng.IScope & StudentCardDirectiveScope} scope */
        link: function (scope) {
            scope.age = function () {
                var born = new Date(scope.student.birthdate);
                return Math.floor((Date.now() - born.getTime()) / (365.25 * 24 * 3600 * 1000));
            };
        },
    };
});
